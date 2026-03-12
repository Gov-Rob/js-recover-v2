/**
 * prep-batches.mjs — Prepare context-enriched batch files for LLM naming
 *
 * USAGE:
 *   node src/llm/prep-batches.mjs --start 0 --count 3 --batch-size 100
 *
 * WHAT IT DOES:
 *   1. Loads uncertain-exact.json (sorted by decl frequency)
 *   2. Filters out already-merged names
 *   3. For each batch, extracts source context via regex (NOT acorn — too slow)
 *   4. Writes /tmp/uncertain-batch{N}.json files ready for multi-model-batch.mjs
 *
 * CONTEXT EXTRACTION PATTERNS (in priority order):
 *   1. var/let/const declaration:  `const foo = <rhs>`  → most informative
 *   2. Assignment:                 `foo = <rhs>`         → shows mutation
 *   3. Call site:                  `foo(<args>)`         → shows usage
 *   4. Property access:            `.foo`                → shows role
 *
 * WHY PYTHON REGEX INSTEAD OF NODE AST?
 *   The 15.5MB Copilot bundle OOMs Node.js when using acorn with locations:true
 *   for context extraction. Python regex on raw source is ~90-130s/300 vars
 *   but memory-safe and sufficient (we only need 1-3 snippets per var).
 *
 * OUTPUT FORMAT per batch:
 *   [ { name: "Xbt", context: ["chunk => chunk.modules", "...", "..."] }, ... ]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i+1] : def;
};

const uncertainPath = getArg('--uncertain', '/tmp/uncertain-exact.json');
const mergedPath    = getArg('--merged',    '/tmp/gap-names-merged.json');
const srcPath       = getArg('--src',       '/root/copilot-src/app.stripped.js');
const startBatch    = parseInt(getArg('--start',      '0'));
const batchCount    = parseInt(getArg('--count',      '3'));
const batchSize     = parseInt(getArg('--batch-size', '100'));
const outPrefix     = getArg('--out-prefix', '/tmp/uncertain-batch');

const uncertain = JSON.parse(readFileSync(uncertainPath, 'utf8'));
const merged    = existsSync(mergedPath)
  ? JSON.parse(readFileSync(mergedPath, 'utf8'))
  : {};
const mergedKeys = new Set(Object.keys(merged));

const unseeded = uncertain.filter(n => !mergedKeys.has(n));
console.log(`Unseeded: ${unseeded.length} / ${uncertain.length}`);

// Use Python for regex-based context extraction (avoids Node OOM on large files)
const pyScript = String.raw`
import json, re, sys
uncertain = json.loads(sys.argv[1])
src = open(sys.argv[2]).read()
out = []
for name in uncertain:
    contexts = []
    pats = [
        r'\b(?:var|let|const)\s+' + re.escape(name) + r'\s*=\s*([^;\n]{1,120})',
        r'\b' + re.escape(name) + r'\s*=\s*([^;\n]{1,120})',
        r'\b' + re.escape(name) + r'\s*\(([^)]{0,80})\)',
        r'\.' + re.escape(name) + r'\b([^;\n]{0,60})',
    ]
    for pat in pats:
        m = re.search(pat, src)
        if m:
            ctx = m.group(1).strip()[:100]
            if ctx:
                contexts.append(ctx)
    out.append({'name': name, 'context': contexts[:3]})
print(json.dumps(out))
`;

for (let b = startBatch; b < startBatch + batchCount; b++) {
  const slice = unseeded.slice((b - startBatch) * batchSize, (b - startBatch + 1) * batchSize);
  if (slice.length === 0) { console.log(`B${b}: empty — done`); break; }

  console.log(`B${b}: extracting context for ${slice.length} vars...`);
  const result = execSync(
    `python3 -c ${JSON.stringify(pyScript)} ${JSON.stringify(JSON.stringify(slice))} ${srcPath}`,
    { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 }
  ).toString();

  const out = JSON.parse(result);
  const outFile = `${outPrefix}${b}.json`;
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`B${b}: ${out.length} vars → ${outFile} (first: ${slice[0]})`);
}
