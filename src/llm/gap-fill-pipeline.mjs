/**
 * gap-fill-pipeline.mjs — Automated GAP_SEEDS population pipeline
 *
 * WHAT THIS DOES:
 *   Extracts the "uncertain" variables from buildRenameMap (those that pass
 *   isMinified() but fail all static phases 1-3), sends them to multi-model
 *   LLM rotation for naming, filters/deduplicates results, and injects them
 *   into GAP_SEEDS in renamer.js. Iterates until the uncertain list is empty
 *   or a coverage target is reached.
 *
 * KEY LEARNINGS (from running against 15.5MB Copilot bundle):
 *
 *   1. EXACT UNCERTAIN LIST IS CRITICAL
 *      - DO NOT batch general short identifiers. Extract ONLY vars that are
 *        genuinely uncertain in buildRenameMap (not in output map, pass isMinified).
 *      - Batches 1-54 wasted effort targeting ~37k general vars; only 29 overlapped
 *        the real uncertain set of 5,323. Switch to exact list = +1.5%/round vs plateau.
 *
 *   2. CONTEXT EXTRACTION: PYTHON REGEX, NOT NODE.JS AST
 *      - acorn parse of 15.5MB with locations:true = OOM (~4GB). Use Python regex
 *        to extract declaration/assignment/call contexts. ~90-130s per 300 vars.
 *
 *   3. SEQUENTIAL BATCHES > PARALLEL BACKGROUND
 *      - `node ... &` heredoc in loops silently drops output files.
 *      - Sequential runBatch() calls are reliable. 3x per shell = ~6 min / 300 vars.
 *
 *   4. FILTER PIPELINE (accept criteria for LLM output):
 *      - k must be in batch_keys (exact match to input vars — no hallucination)
 *      - v must be string, length 3-60
 *      - v must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/  (valid JS identifier)
 *      - k not already in merged; v not already a value (unique naming)
 *
 *   5. DOUBLE-COMMA BUG after injection:
 *      - Regex anchor replacement can produce "'foo': 'bar',," at join point.
 *      - Always run: re.sub(r"'([^']+)',,", r"'\1',", content) after injection.
 *      - Always run: node --check renamer.js before proceeding.
 *
 *   6. MODEL ROTATION BEHAVIOUR (GitHub Copilot API, device auth):
 *      - gemini-2.5-pro:     ~90% success rate, returns clean JSON
 *      - gpt-4o-2024-11-20:  ~85% success rate, clean JSON
 *      - claude-opus-4.6:    ~50% success, fails with "not supported" ~50% of chunks
 *      - gpt-5.1/5.2-codex:  ~10% success, mostly 400/401 errors — skip early
 *      - Best strategy: rotate, skip models that fail 2+ consecutive chunks
 *
 *   7. COVERAGE GROWTH RATE:
 *      - 300 vars/round → ~235-251 accepted → ~+1.2-1.5% coverage
 *      - Plateau at 68.7% was caused by targeting wrong var set
 *      - With exact uncertain list: linear ~1.4%/round, no plateau observed
 *
 *   8. COPILOT BUNDLE PATTERNS (app.stripped.js, 15.5MB, 18,065 bindings):
 *      - Most uncertain vars are short (2-4 chars): event handlers, state vars,
 *        React hooks, TypeScript generic type params leaked to runtime
 *      - High-frequency vars (Rn, de, It, Ot) = likely React internals or
 *        Copilot's own core objects — these may be IMPORTED not declared,
 *        so they never reach GAP_SEEDS (not in declared bindings)
 *      - Pattern: 2-char vars ending in 'n' = often event/node types
 *      - Pattern: vars like 'Xbt', 'Ybt' = likely bundle chunk IDs or
 *        webpack-generated module references
 *
 * USAGE:
 *   node gap-fill-pipeline.mjs --rounds 5 --batch-size 100
 *   node gap-fill-pipeline.mjs --until 90  # run until 90% coverage
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const RENAMER   = path.join(REPO_ROOT, 'src/passes/renamer.js');
const MERGED    = '/tmp/gap-names-merged.json';
const UNCERTAIN = '/tmp/uncertain-exact.json';

// ── Utilities ────────────────────────────────────────────────────────────────

function loadMerged() {
  if (!existsSync(MERGED)) return {};
  return JSON.parse(readFileSync(MERGED, 'utf8'));
}

function loadUncertain() {
  if (!existsSync(UNCERTAIN)) throw new Error(
    'Run extract-uncertain.mjs first to generate ' + UNCERTAIN
  );
  return JSON.parse(readFileSync(UNCERTAIN, 'utf8'));
}

function filterBatchOutput(raw, batchKeys, merged) {
  const mergedKeys = new Set(Object.keys(merged));
  const seenVals   = new Set(Object.values(merged));
  const accepted   = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!batchKeys.has(k))                          continue; // hallucination guard
    if (typeof v !== 'string')                      continue;
    if (v.length < 3 || v.length > 60)             continue;
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(v))    continue; // valid JS ident
    if (mergedKeys.has(k) || seenVals.has(v))       continue; // dedup
    accepted[k] = v;
    mergedKeys.add(k);
    seenVals.add(v);
  }
  return accepted;
}

function injectIntoRenamer(newEntries, batchLabel) {
  let content = readFileSync(RENAMER, 'utf8');
  const existing = new Set(
    [...content.matchAll(/    '([A-Za-z0-9\$_]{2,6})': '/g)].map(m => m[1])
  );
  const toAdd = Object.entries(newEntries).filter(([k]) => !existing.has(k));
  if (toAdd.length === 0) {
    console.log('Nothing new to inject.');
    return 0;
  }

  // Find the closing }; of GAP_SEEDS (last match of entry+close pattern)
  const matches = [...content.matchAll(/    '([A-Za-z0-9\$_]{2,6})': '([^']+)',\n  \};/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('Could not find GAP_SEEDS closing anchor in renamer.js');

  const lines = toAdd.map(([k, v]) => `    '${k}': '${v}',`).join('\n');
  const block = `// ${batchLabel}\n${lines}\n  };`;
  const before = content.slice(0, last.index + last[0].length - '\n  };'.length);
  const after  = content.slice(last.index + last[0].length);
  content = before + ',\n' + block + after;

  // Fix double-comma (joining bug)
  content = content.replace(/'([^']+)',,/g, "'$1',");

  writeFileSync(RENAMER, content);
  execSync(`node --check ${RENAMER}`); // throws if syntax broken
  console.log(`Injected ${toAdd.length} entries (${batchLabel})`);
  return toAdd.length;
}

export { loadMerged, loadUncertain, filterBatchOutput, injectIntoRenamer };
