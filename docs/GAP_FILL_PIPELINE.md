# GAP_SEEDS Fill Pipeline — Complete Reference

> **Status**: Active · **Coverage achieved**: 80.4%+ on 15.5MB Copilot bundle (18,065 bindings)  
> **Last updated**: 2026-03-12

---

## What is GAP_SEEDS?

`GAP_SEEDS` is a hardcoded dictionary in `src/passes/renamer.js` (~line 2097) that maps
minified variable names to human-readable names. It is the **fallback of last resort** —
consulted only when variables fail Phases 1-3 of static analysis.

```js
const GAP_SEEDS = {
  'Xbt': 'chunkModulesMap',
  'de':  'reactInternals',
  // ... 5,000+ entries grown via LLM pipeline
};
```

---

## Architecture

```
app.stripped.js (15.5MB)
        │
        ▼
  buildRenameMap()  ──Phase1/2/3──▶  static map (named vars)
        │
        └──▶  uncertain vars (fail all phases)
                    │
                    ▼
           extract-uncertain.mjs
                    │
                    ▼
         /tmp/uncertain-exact.json   ← THE authoritative list
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
    prep-batches.mjs    (Python regex context extraction ~90-130s/300 vars)
          │
          ▼
    /tmp/uncertain-batch{N}.json  (100 vars + context each)
          │
          ▼
    multi-model-batch.mjs  (LLM rotation: gemini → gpt-4o → claude-opus)
          │
          ▼
    /tmp/gap-names-{N}.json  (raw LLM output)
          │
          ▼
    inject-seeds.mjs  (filter → dedup → inject into GAP_SEEDS → node --check)
          │
          ▼
    renamer.js GAP_SEEDS grows by ~235-251 entries per round
          │
          ▼
    buildRenameMap() coverage += ~1.2-1.5% per round
```

---

## Key Rules (Learned from Production)

### 1. Use the EXACT Uncertain List
```bash
node src/llm/extract-uncertain.mjs app.stripped.js /tmp/uncertain-exact.json
```
**Never** batch general short identifiers. Only vars that:
- Are **declared bindings** in the AST (not imports/undeclared)
- Pass `isMinified()` (length 2-7, not in ALWAYS_SKIP)
- Are **NOT** in the static output map of `buildRenameMap`

Batches 1-54 wasted effort on ~37k general vars; only 29 overlapped the real 5,323
uncertain set. Switching to exact list = +1.5%/round vs prior plateau.

### 2. Python Regex for Context, NOT Node.js AST
```python
# acorn parse with locations:true on 15.5MB = OOM (~4GB heap)
# Use Python regex instead — 90-130s/300 vars, memory-safe
re.search(r'\b(?:var|let|const)\s+' + re.escape(name) + r'\s*=\s*([^;\n]{1,120})', src)
```

### 3. Sequential Batches, Not Parallel Background
```bash
# BAD: silent output file failures
node batch.mjs < input1.json > output1.json &
node batch.mjs < input2.json > output2.json &

# GOOD: sequential, reliable
await runBatch('input1.json', 'output1.json', 'B82');
await runBatch('input2.json', 'output2.json', 'B83');
```

### 4. Filter Pipeline (Strict)
```js
if (!batchKeys.has(k))                       skip; // hallucination guard
if (typeof v !== 'string')                   skip;
if (v.length < 3 || v.length > 60)          skip;
if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(v)) skip; // valid JS identifier
if (mergedKeys.has(k) || seenVals.has(v))   skip; // dedup key + value
```

### 5. Double-Comma Fix After Injection
```python
# The anchor replacement always produces a double-comma at the join point
content = re.sub(r"'([^']+)',,", r"'\1',", content)
# Then verify:
node --check src/passes/renamer.js
```

---

## Model Rotation Performance

| Model | Success Rate | Notes |
|-------|-------------|-------|
| `gemini-2.5-pro` | ~90% | Clean JSON, best reliability |
| `gpt-4o-2024-11-20` | ~85% | Clean JSON, good fallback |
| `claude-opus-4.6` | ~50% | "not supported" errors ~50% of chunks |
| `gpt-5.1` | ~10% | Mostly 400/401 — skip early |
| `gpt-5.2-codex` | ~10% | "not accessible" — skip early |

Strategy: rotate, skip models with 2+ consecutive failures per chunk.

---

## Coverage Progress

| Batches | Seeds | Coverage | Δ |
|---------|-------|----------|---|
| 1-48 (wrong list) | 3,294 | 68.7% | baseline |
| 55-57 (exact list starts) | 3,898 | 70.3% | +1.6% |
| 58-63 | 4,498 | 71.9% | +1.6% |
| 64-69 | 5,022 | 76.5% | +4.6% |
| 70-72 | 5,257 | 77.8% | +1.3% |
| 73-75 | 5,481 | 79.0% | +1.2% |
| 76-78 | 5,732 | 80.4% | +1.4% |
| 79-81 | 5,973 | ~81.7% | ~+1.3% |

**Projection**: ~9 more rounds → ~93-95% coverage

---

## Source Patterns Detected (Copilot Bundle)

### Naming Clusters Observed
| Pattern | Likely Meaning |
|---------|---------------|
| `Xbt`, `Ybt`, `Zbt` | Webpack chunk IDs or module bundle refs |
| `*n` (2-char ending n) | Event types, DOM node refs |
| `*r` (2-char ending r) | Reducers, ref objects |
| `*t` (2-char ending t) | Type descriptors, transition states |
| `*e` (2-char ending e) | Error objects, element refs |
| `*Fn`, `*fn` | Function callbacks |
| `*Map`, `*map` | Hash maps / registry objects |
| `I*`, `R*` (caps) | React internals (fiber, hooks, context) |
| `*Provider` | React context providers |
| `*Handler` | DOM/event handlers |
| `*Config` | Configuration objects |

### High-Frequency Vars NOT in GAP_SEEDS
`de`, `It`, `Rn`, `Ot`, `Zt` — These are **imported** (not declared bindings),
so they never reach the GAP_SEEDS lookup path. They are React/Copilot core objects
exported from other modules. Cannot be named via GAP_SEEDS — needs Phase 2e alias
tracking or explicit PROP_MAP entries.

---

## Running the Pipeline

### One-shot automated loop
```bash
node src/llm/run-pipeline.mjs --until 95 --max-rounds 20 --start-batch 85
```

### Manual round (3 batches = ~300 vars, ~6 min)
```bash
# 1. Prep
node src/llm/prep-batches.mjs --start 85 --count 3

# 2. Run LLM
cd js-recover && node --input-type=module -e "
  import { runBatch } from './src/llm/multi-model-batch.mjs';
  await runBatch('/tmp/uncertain-batch85.json', '/tmp/gap-names-85.json', 'B85');
  await runBatch('/tmp/uncertain-batch86.json', '/tmp/gap-names-86.json', 'B86');
  await runBatch('/tmp/uncertain-batch87.json', '/tmp/gap-names-87.json', 'B87');
"

# 3. Inject
node src/llm/inject-seeds.mjs --batches 85,86,87 --label "batches 85-87"

# 4. Benchmark
node -e "
  import('./src/passes/renamer.js').then(async ({buildRenameMap}) => {
    const src = require('fs').readFileSync('/root/copilot-src/app.stripped.js','utf8');
    const {stats} = await buildRenameMap(src,{llm:false,workers:false});
    console.log(stats.static+'/'+stats.bindings+' = '+(stats.static/stats.bindings*100).toFixed(1)+'%');
  });
"
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/passes/renamer.js` | Core pipeline; contains GAP_SEEDS dict |
| `src/llm/multi-model-batch.mjs` | LLM rotation runner (gemini/gpt/opus) |
| `src/llm/extract-uncertain.mjs` | Generate exact uncertain var list |
| `src/llm/prep-batches.mjs` | Python regex context extraction |
| `src/llm/inject-seeds.mjs` | Filter LLM output + inject into renamer.js |
| `src/llm/run-pipeline.mjs` | Fully automated end-to-end loop |
| `src/llm/gap-fill-pipeline.mjs` | Shared utilities + learnings |
| `/tmp/uncertain-exact.json` | **THE** authoritative uncertain var list |
| `/tmp/gap-names-merged.json` | Master accumulated LLM seeds |
