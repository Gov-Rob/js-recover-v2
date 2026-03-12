# Renamer Architecture — js-recover

> Phase-by-phase breakdown of how `src/passes/renamer.js` names minified variables.

---

## Five-Phase Pipeline

```
Input: minified JS source
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 1 — INIT Analysis                                  │
  │   What is each var initialized to?                       │
  │   • string literal → "stringConstant"                   │
  │   • new Foo()      → "fooInstance"                      │
  │   • require('x')   → "xModule"                          │
  │   • function()     → "anonymousFn"                      │
  └─────────────────┬───────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 2 — USAGE Analysis (single-pass O(n))             │
  │   How is each var used?                                  │
  │  2a USAGE:    call site, assignment, property access     │
  │  2b SHAPE:    what properties are read from it (.foo)    │
  │  2c DESTRUCT: what keys are destructured ({ key })       │
  │  2d CALL-ARG: type inferred from argument position       │
  │  2e ALIAS:    type propagation via `b = a` assignments   │
  └─────────────────┬───────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 3 — MATH Analysis                                  │
  │   • Frequency rank (how often declared vs used)          │
  │   • Terser sequence detection (generated var patterns)   │
  │   • Shannon entropy (random vs structured names)         │
  └─────────────────┬───────────────────────────────────────┘
                    │
                    ├──▶ confident enough? → STATIC NAME ✓
                    │
                    ▼  (uncertain vars only)
  ┌─────────────────────────────────────────────────────────┐
  │ GAP_SEEDS lookup                                         │
  │   Dict of LLM-generated names from prior pipeline runs  │
  │   ~5,000-6,000 entries, grown iteratively               │
  │   Only consulted when confidence < minConfidence         │
  └─────────────────┬───────────────────────────────────────┘
                    │
                    ├──▶ found in GAP_SEEDS? → NAME ✓
                    │
                    ▼  (still uncertain)
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 4 — COPILOT LLM (optional, --llm flag)            │
  │   Batch uncertain vars to GitHub Copilot API            │
  │   Uses multi-model rotation (gemini/gpt-4o/claude)      │
  │   Results fed back into GAP_SEEDS for future runs       │
  └─────────────────┬───────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 5 — HELIX GRAPH (optional, --graph flag)          │
  │   Co-occurrence graph via HelixHyper MCP                │
  │   Community detection propagates names to clusters       │
  └─────────────────────────────────────────────────────────┘
        │
        ▼
  Output: { map: {minName: readableName}, stats }
```

---

## isMinified() Criteria

```js
const ALWAYS_SKIP = new Set([
  'i','j','k','n','s','e','t','r','x','y',
  'ok','id','fn','cb','el','ms','db','fs','vm',
  'io','os','if','do','in','of','to','is','on',
  'by','at','up','go','no','me','my','we'
]);

function isMinified(name) {
  return (
    name.length >= 2 && name.length <= 7 &&
    !ALWAYS_SKIP.has(name) &&
    /^[a-zA-Z$_][a-zA-Z0-9$_]{1,5}$/.test(name)
  );
}
```

---

## GAP_SEEDS Structure

```js
// src/passes/renamer.js ~line 2097
const GAP_SEEDS = {
  // batches 1-54 (mixed quality, some not in uncertain set)
  'Xbt': 'chunkModulesMap',
  // ...

  // batches 55+ (exact uncertain list — high quality)
  // batches 55-57
  'UCe': 'userContextExtractor',
  // ...

  // batches 79-81
  'mQn': 'menuQueryNode',
  // ... ~6,000+ total entries
};
```

**Growth pattern**: Each round of 3 batches (300 uncertain vars) adds ~235-251 entries
= ~+1.3% coverage on the 18,065-binding Copilot bundle.

---

## Benchmark Command

```bash
cd /root/repos/js-recover
node --input-type=module << 'EOF'
import { buildRenameMap } from './src/passes/renamer.js';
import { readFileSync } from 'fs';
const src = readFileSync('/root/copilot-src/app.stripped.js', 'utf8');
const { stats } = await buildRenameMap(src, { llm: false, workers: false });
console.log(`${stats.static}/${stats.bindings} = ${(stats.static/stats.bindings*100).toFixed(1)}%`);
console.log(`uncertain: ${stats.uncertain}`);
EOF
```

---

## Known Limitations

1. **Imported vars never reach GAP_SEEDS** — `de`, `It`, `Rn`, `Ot`, `Zt` are imported
   not declared, so the binding walker skips them. Need PROP_MAP or alias tracking.

2. **Node.js OOM on 15.5MB + locations:true** — Always parse with `locations: false`.
   Use Python regex for source context extraction.

3. **Claude-opus-4.6 ~50% failure rate** — "not supported" on GitHub Copilot API.
   gemini-2.5-pro and gpt-4o-2024-11-20 are primary workhorses.

4. **Coverage ceiling ~93-95%** — Some vars genuinely have no context (single-use
   temporaries, minifier-generated loops). These cannot be named without the full
   call graph.
