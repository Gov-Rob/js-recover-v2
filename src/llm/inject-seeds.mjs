/**
 * inject-seeds.mjs — Filter LLM output and inject into GAP_SEEDS in renamer.js
 *
 * USAGE:
 *   node src/llm/inject-seeds.mjs --batches 79,80,81 --label "batches 79-81"
 *
 * WHAT IT DOES:
 *   1. Loads each gap-names-{N}.json (LLM raw output)
 *   2. Filters with strict criteria (see FILTER PIPELINE below)
 *   3. Appends accepted entries to gap-names-merged.json
 *   4. Injects new entries into GAP_SEEDS in renamer.js
 *   5. Fixes double-comma injection bug
 *   6. Runs node --check to verify syntax
 *   7. Reports coverage improvement estimate
 *
 * FILTER PIPELINE:
 *   - k ∈ batch_keys (exact input var — blocks hallucination)
 *   - typeof v === 'string' && v.length ∈ [3, 60]
 *   - v matches /^[a-zA-Z_$][a-zA-Z0-9_$]*$/  (valid JS identifier)
 *   - k not in merged (dedup by key)
 *   - v not in merged values (dedup by value — unique names only)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const RENAMER   = path.join(REPO_ROOT, 'src/passes/renamer.js');
const MERGED    = '/tmp/gap-names-merged.json';

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : def; };

const batchNums = getArg('--batches', '').split(',').map(Number).filter(Boolean);
const label     = getArg('--label', `batches ${batchNums.join(',')}`);
const rawPrefix = getArg('--raw-prefix', '/tmp/gap-names-');
const batchPfx  = getArg('--batch-prefix', '/tmp/uncertain-batch');

if (batchNums.length === 0) {
  console.error('Usage: inject-seeds.mjs --batches 79,80,81 [--label "batches 79-81"]');
  process.exit(1);
}

// ── Load state ───────────────────────────────────────────────────────────────
const merged    = existsSync(MERGED) ? JSON.parse(readFileSync(MERGED, 'utf8')) : {};
const mergedKeys = new Set(Object.keys(merged));
const seenVals   = new Set(Object.values(merged));

// ── Filter + merge ───────────────────────────────────────────────────────────
let totalNew = 0;
for (const B of batchNums) {
  const rawFile   = `${rawPrefix}${B}.json`;
  const batchFile = `${batchPfx}${B}.json`;

  if (!existsSync(rawFile))   { console.warn(`B${B}: missing ${rawFile}`);   continue; }
  if (!existsSync(batchFile)) { console.warn(`B${B}: missing ${batchFile}`); continue; }

  const raw   = JSON.parse(readFileSync(rawFile, 'utf8'));
  const batch = JSON.parse(readFileSync(batchFile, 'utf8'));
  const batchKeys = new Set(batch.map(b => b.name));

  let added = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!batchKeys.has(k))                       continue;
    if (typeof v !== 'string')                   continue;
    if (v.length < 3 || v.length > 60)          continue;
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(v)) continue;
    if (mergedKeys.has(k) || seenVals.has(v))   continue;
    merged[k] = v;
    mergedKeys.add(k); seenVals.add(v);
    added++; totalNew++;
  }
  console.log(`B${B}: raw=${Object.keys(raw).length}, accepted=${added}`);
}

writeFileSync(MERGED, JSON.stringify(merged, null, 2));
console.log(`\nMerged total: ${Object.keys(merged).length} (+${totalNew})`);

// ── Inject into renamer.js ───────────────────────────────────────────────────
if (totalNew === 0) { console.log('Nothing new to inject.'); process.exit(0); }

let content = readFileSync(RENAMER, 'utf8');
const existingKeys = new Set(
  [...content.matchAll(/    '([A-Za-z0-9\$_]{2,6})': '/g)].map(m => m[1])
);
const toAdd = Object.entries(merged).filter(([k]) => !existingKeys.has(k));
console.log(`Injecting ${toAdd.length} new entries...`);

const matches = [...content.matchAll(/    '([A-Za-z0-9\$_]{2,6})': '([^']+)',\n  \};/g)];
const last = matches[matches.length - 1];
if (!last) { console.error('Cannot find GAP_SEEDS closing anchor'); process.exit(1); }

const anchor  = last[0];
const lines   = toAdd.map(([k, v]) => `    '${k}': '${v}',`).join('\n');
const block   = `// ${label}\n${lines}\n  };`;
const newTail = anchor.replace('\n  };', ',\n' + block);
content = content.slice(0, last.index) + newTail + content.slice(last.index + anchor.length);

// Fix double-comma bug
content = content.replace(/'([^']+)',,/g, "'$1',");

writeFileSync(RENAMER, content);

try {
  execSync(`node --check ${RENAMER}`, { stdio: 'pipe' });
  console.log('✓ Syntax OK');
} catch(e) {
  console.error('✗ Syntax error!', e.stderr?.toString());
  process.exit(1);
}
