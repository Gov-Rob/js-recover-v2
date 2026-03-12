/**
 * run-pipeline.mjs — Fully automated gap-fill loop
 *
 * USAGE:
 *   node src/llm/run-pipeline.mjs [--until 90] [--max-rounds 20] [--batch-size 100]
 *
 * This runs the full loop autonomously:
 *   1. Load uncertain-exact.json + merged seeds
 *   2. Filter unseeded vars
 *   3. Prep 3 batches (Python regex context extraction)
 *   4. Run 3 batches sequentially (multi-model LLM rotation)
 *   5. Filter + inject into renamer.js
 *   6. Benchmark coverage
 *   7. Repeat until --until target or --max-rounds reached
 *
 * AUTONOMOUS — no human intervention needed between rounds.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { runBatch } from './multi-model-batch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const RENAMER   = path.join(REPO_ROOT, 'src/passes/renamer.js');
const MERGED    = '/tmp/gap-names-merged.json';
const UNCERTAIN = '/tmp/uncertain-exact.json';
const SRC       = '/root/copilot-src/app.stripped.js';

const args = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d; };

const TARGET_PCT  = parseFloat(getArg('--until',       '95'));
const MAX_ROUNDS  = parseInt(getArg('--max-rounds',    '30'));
const BATCH_SIZE  = parseInt(getArg('--batch-size',    '100'));
const BATCHES_PER = parseInt(getArg('--batches-per',   '3'));
const START_BATCH = parseInt(getArg('--start-batch',   '82')); // continue from last

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadMerged() {
  return existsSync(MERGED) ? JSON.parse(readFileSync(MERGED, 'utf8')) : {};
}

function getUnseeded(merged) {
  const uncertain = JSON.parse(readFileSync(UNCERTAIN, 'utf8'));
  const keys = new Set(Object.keys(merged));
  return uncertain.filter(n => !keys.has(n));
}

function extractContextPy(names) {
  const py = String.raw`
import json, re, sys
names = json.loads(sys.argv[1])
src = open(sys.argv[2]).read()
out = []
for name in names:
    ctx = []
    for pat in [
        r'\b(?:var|let|const)\s+' + re.escape(name) + r'\s*=\s*([^;\n]{1,120})',
        r'\b' + re.escape(name) + r'\s*=\s*([^;\n]{1,120})',
        r'\b' + re.escape(name) + r'\s*\(([^)]{0,80})\)',
    ]:
        m = re.search(pat, src)
        if m:
            c = m.group(1).strip()[:100]
            if c: ctx.append(c)
    out.append({'name': name, 'context': ctx[:3]})
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-c', py, JSON.stringify(names), SRC],
    { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 });
  if (r.status !== 0) throw new Error('Python context extraction failed:\n' + r.stderr?.toString());
  return JSON.parse(r.stdout.toString());
}

function filterAndMerge(raw, batchKeys, merged) {
  const keys = new Set(Object.keys(merged));
  const vals = new Set(Object.values(merged));
  let added = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!batchKeys.has(k) || typeof v !== 'string') continue;
    if (v.length < 3 || v.length > 60)              continue;
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(v))     continue;
    if (keys.has(k) || vals.has(v))                  continue;
    merged[k] = v; keys.add(k); vals.add(v); added++;
  }
  return added;
}

function injectAndVerify(merged, label) {
  let content = readFileSync(RENAMER, 'utf8');
  const existing = new Set(
    [...content.matchAll(/    '([A-Za-z0-9\$_]{2,6})': '/g)].map(m => m[1])
  );
  const toAdd = Object.entries(merged).filter(([k]) => !existing.has(k));
  if (toAdd.length === 0) return 0;

  const matches = [...content.matchAll(/    '([A-Za-z0-9\$_]{2,6})': '([^']+)',\n  \};/g)];
  const last = matches[matches.length - 1];
  const lines = toAdd.map(([k, v]) => `    '${k}': '${v}',`).join('\n');
  const block = `// ${label}\n${lines}\n  };`;
  const newTail = last[0].replace('\n  };', ',\n' + block);
  content = content.slice(0, last.index) + newTail + content.slice(last.index + last[0].length);
  content = content.replace(/'([^']+)',,/g, "'$1',");
  writeFileSync(RENAMER, content);
  execSync(`node --check ${RENAMER}`, { stdio: 'pipe' });
  return toAdd.length;
}

async function benchmark() {
  const r = spawnSync('node', ['--input-type=module'], {
    input: `
import { buildRenameMap } from '${RENAMER}';
import { readFileSync } from 'fs';
const src = readFileSync('${SRC}', 'utf8');
const { stats } = await buildRenameMap(src, { llm: false, workers: false });
process.stdout.write(JSON.stringify(stats));
`,
    maxBuffer: 10 * 1024 * 1024, timeout: 120_000,
    cwd: REPO_ROOT
  });
  return JSON.parse(r.stdout.toString());
}

// ── Main loop ────────────────────────────────────────────────────────────────

let round = 0;
let batchNum = START_BATCH;

console.log(`\n🚀 GAP-FILL PIPELINE — target: ${TARGET_PCT}%, max rounds: ${MAX_ROUNDS}`);
console.log(`   Starting at batch #${batchNum}, ${BATCHES_PER} batches × ${BATCH_SIZE} vars per round\n`);

for (round = 0; round < MAX_ROUNDS; round++) {
  let merged = loadMerged();
  const unseeded = getUnseeded(merged);

  if (unseeded.length === 0) {
    console.log('✅ All uncertain vars seeded!');
    break;
  }

  console.log(`\n─── Round ${round + 1} | Batch #${batchNum} | Unseeded: ${unseeded.length} ───`);

  // Prep + run batches
  let totalAdded = 0;
  const batchesRun = [];

  for (let b = 0; b < BATCHES_PER; b++) {
    const slice = unseeded.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    if (slice.length === 0) break;

    const bn = batchNum + b;
    const batchFile = `/tmp/uncertain-batch${bn}.json`;
    const rawFile   = `/tmp/gap-names-${bn}.json`;

    console.log(`  Extracting context for B${bn} (${slice.length} vars)...`);
    const batchData = extractContextPy(slice);
    writeFileSync(batchFile, JSON.stringify(batchData, null, 2));

    console.log(`  Running LLM B${bn}...`);
    const raw = await runBatch(batchFile, rawFile, `B${bn}`);

    merged = loadMerged(); // reload after potential concurrent writes
    const batchKeys = new Set(batchData.map(b => b.name));
    const added = filterAndMerge(raw, batchKeys, merged);
    writeFileSync(MERGED, JSON.stringify(merged, null, 2));
    console.log(`  B${bn}: +${added} accepted`);
    totalAdded += added;
    batchesRun.push(bn);
  }

  // Inject
  merged = loadMerged();
  const label = `batches ${batchNum}-${batchNum + BATCHES_PER - 1}`;
  const injected = injectAndVerify(merged, label);
  console.log(`  Injected: ${injected} | Total seeds: ${Object.keys(merged).length}`);

  batchNum += BATCHES_PER;

  // Benchmark every round
  console.log('  Benchmarking...');
  const stats = await benchmark();
  const pct = (stats.static / stats.bindings * 100).toFixed(1);
  console.log(`  📊 Coverage: ${stats.static}/${stats.bindings} = ${pct}% | uncertain: ${stats.uncertain}`);

  if (parseFloat(pct) >= TARGET_PCT) {
    console.log(`\n🎯 Target ${TARGET_PCT}% reached!`);
    break;
  }
}

console.log(`\n✅ Pipeline complete after ${round + 1} rounds.`);
