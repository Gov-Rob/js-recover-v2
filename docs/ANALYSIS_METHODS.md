# js-recover Analysis Methods Reference

This document captures all analysis techniques used in `src/passes/renamer.js`,
including empirical findings from the 15.5MB GitHub Copilot bundle (18,066 bindings).

---

## Coverage Benchmarks (Copilot app.stripped.js, 18,066 bindings)

| Version | Static-Only | With Seeds | Key Addition |
|---------|-------------|------------|--------------|
| v3 | ~45% | — | Baseline |
| v4 | ~58% | — | Shape rules, prop aggregation |
| v5 | 65.1% (11,766) | 98.2% | O(n) re-arch, seeds pipeline |
| **v6** | **67.4% (12,177)** | **98.2%+** | Symbol.for, classes, string-literals |
| v6+Opus | ~85%+ (est) | — | Full Opus 4.6 pass (5,563 vars) |

---

## Phase 1: Init Scoring (`scoreInit`)

Examines the **right-hand side** of a variable's first assignment. Returns `{name, score}`.

### Score table

| Score | Meaning | Example |
|-------|---------|---------|
| 10 | Certain (known ctor) | `new Map()` → `map` |
| 9 | Very high confidence | `Symbol.for("pkg.ERR_NAME")` → `sym_pkgErrName` |
| 9 | Error class | `class X extends Error {}` → `errClass` |
| 8 | High confidence | `new EventEmitter()` → `emitter` |
| 7 | Good confidence | `class X extends Y {}` → `subClass` |
| 6 | Medium-high | `"Connect Timeout Error"` → `connectTimeoutMsg` |
| 5 | Medium | `/pattern/flags` → `rePattern` |
| 3 | Low fallback | `"somestring"` → `str` |

### Known constructor patterns (`CTOR_CALLS`)
Covers 40+ constructors: `Map`, `Set`, `Promise`, `EventEmitter`, `Buffer`, `WeakMap`, `URL`, `Worker`, `WebSocket`, `AbortController`, `ReadableStream`, `WritableStream`, etc.

### `symbolKeyToName(key)` — v6
Converts `Symbol.for()` keys to readable names:
- `"undici.error.UND_ERR_CONNECT_TIMEOUT"` → `sym_undiciConnectTimeout`
- Strategy: take last 3 meaningful dot-segments, strip `UND_ERR_` prefixes, camelCase, prefix `sym_`
- **Empirical**: 823 vars in Copilot bundle follow this pattern

### `stringLiteralToName(str)` — v6
Converts descriptive string literals to names:
- Multi-word mixed-case → camelCase + `Msg` suffix (score 6)
- `ALL_CAPS` → `K_` prefix (score 8)
- `camelCase.dotted` → `K_` prefix (score 7)
- **Empirical**: 23 descriptive strings found (`connectTimeoutMsg`, `windowsShellMsg`, etc.)

---

## Phase 2: Usage Index (`buildUsageIndex`)

O(n) single AST walk capturing how each minified var is **used** (not declared).
40+ patterns covering:

- **Streams**: `.pipe()`, `.write()`, `.read()`, `.on('data')` → `stream`
- **Promises**: `.then()`, `.catch()`, `.finally()`, `await` → `promise`
- **EventEmitters**: `.emit()`, `.on()`, `.addListener()` → `emitter`
- **Maps/Sets**: `.get()`, `.set()`, `.has()`, `.delete()` → `map`/`set`
- **HTTP**: `.statusCode`, `.headers`, `.method`, `.url` → `req`/`res`/`httpClient`
- **Crypto**: `.update()`, `.digest()`, `.createHash()` → `hasher`/`cipher`
- **Workers**: `.postMessage()`, `.terminate()` → `worker`
- **WebSocket**: `.send()`, `.close()`, `.readyState` → `ws`

### Event handler naming (`EVENT_HANDLER_MAP`)
When `x.on('error', minVar)`, the variable gets named `errorHandler`, `dataHandler`, etc.

---

## Phase 2b: Shape Analysis (`buildShapeIndex` + `SHAPE_RULES`)

Clusters properties accessed on each variable and matches against semantic clusters.

### Key SHAPE_RULES clusters
```
{statusCode, headers, method} → req
{hostname, port, path, auth}  → urlParts  
{key, value, ttl}             → cacheEntry
{source, destination, code}   → redirect
{name, message, stack}        → error
{rows, columns, count}        → dbResult
```

### `buildPropAggScore` — aggregate PROP_MAP scoring
When no single shape cluster matches, aggregate all accessed properties through
`PROP_MAP` (200+ property→type mappings) and take the dominant type.
- **Empirical**: catches ~3,000+ vars with mixed property access patterns

---

## Phase 2c: Destructuring Analysis

Extracts keys from destructuring patterns: `const { statusCode, body } = x`.
Key set `{statusCode, body}` → `res` (HTTP response).

### `nameFromDestructKeys(keys)` scoring
- 3+ matching keys in a cluster → score 8
- 2 keys → score 6  
- 1 key → score 4

---

## Phase 2d: Call-site Argument Typing

When `fn(minVar, ...)` and `fn` is known (in `KNOWN_FN_SIGS`), infer type from position.
Example: `http.request(url, options, callback)` → position 0 = `url`, position 1 = `obj`, position 2 = `fn`.

---

## Phase 2e: Alias Propagation

When `a = b` and `b` has a known type, propagate to `a`.
Supports multi-hop chains (max 4 hops to avoid cycles).

---

## Phase 2g: Symbol.for + Class Declarations — v6

Additional AST walk for patterns missed by Phase 1 (re-assignments, expressions).

### Symbol.for() detection
```js
// Catches: var X = Symbol.for("pkg.ERR_NAME")
// Also catches: X = Symbol.for("pkg.ERR_NAME") (assignment, not var decl)
```
Extends `INIT_NAME_TO_TYPE` with `namedSym → 'symbol'` at runtime.

### ClassDeclaration handling (Phase 1 visitor)
```js
class X extends Error {}      // → errClass (score 9)  
class X extends SomeClass {}  // → subClass (score 8)
class X {}                    // → classDef (score 7)
```
**Empirical**: 97/98 class declarations in Copilot bundle have minified names.
940 vars named errClass/subClass/classDef.

---

## Phase 3: Math Analysis (Worker Threads)

Worker threads parse arithmetic expressions and detect:
- Bitwise ops on small integers → `flags`/`bitmask`
- Large prime moduli → `hashPrime`
- Constants matching known values → `PI`, `E`, etc.
- Files > 3MB → workers disabled (runs single-threaded)

---

## Phase 4: LLM Naming (Opus 4.6)

For vars still uncertain after all static passes:
- Model: `claude-opus-4.6` (preferred), fallback to `claude-sonnet-4.6`, `gpt-4o`
- Context: `extractContextMulti(source, name, 3, 500)` — 3 occurrences, 500-char radius each
- Batch: 200 vars/call (Opus 128K window accommodates ~400 vars but 200 is safe)
- Input: minified name + multi-occurrence source context
- Output: semantic name (single identifier, no prefix needed)

### Prompt design insights
- Multi-occurrence context (3 snippets) dramatically improves naming accuracy vs single snippet
- Joining snippets with ` | ` separator keeps token count bounded
- Asking for "identifier only, no explanation" reduces output tokens by 80%
- Ranking uncertain vars by usage frequency (most-used first) maximizes high-value naming

---

## Phase 5: Graph Analysis (HelixHyper — `--graph` flag)

Community detection via HelixHyper knowledge graph:
- Each variable is a node; edges = co-occurrence in same function/call
- Community detection clusters semantically related vars
- LLM names 3 seeds per cluster, propagates to cluster members
- **Best for**: large codebases with many co-occurring minified vars

---

## Seed Files

Seeds bypass all analysis for listed vars:
```json
{"Dan": "undiciSymbol", "zan": "errConnectTimeout", ...}
```

### Generating seeds
```bash
node bin/cli.js rename input.js --llm --seeds seeds/copilot-app.seeds.json
```

### `copilot-app.seeds.json`
- 9,131 entries for GitHub Copilot `app.stripped.js`
- Covers 98.2% of 18,066 bindings
- Generated via multi-pass LLM naming sessions

---

## `isMinified(name)` — What Gets Renamed

Only processes names matching:
- Length ≤ 7 characters, AND
- Not in `ALWAYS_SKIP` set (common non-minified names like `i`, `key`, `val`, `err`, `res`, etc.)

**Empirical**: `ALWAYS_SKIP` size matters — too aggressive = miss real minified vars; too loose = rename readable vars.

---

## Known Gaps (as of v6)

1. **Scope-aware params**: Promise `resolve`/`reject` args, for-loop `i`/`j` iterators not yet auto-named
2. **Computed properties**: `obj[minVar]` patterns not tracked in shape analysis  
3. **Template literal vars**: `` `${minVar}` `` type hints not extracted
4. **Generator yield types**: `yield minVar` not analysed for type propagation
5. **Ternary init patterns**: `x = cond ? new Map() : new Set()` — only first branch captured

---

## Performance Profile (15.5MB file, i5-grade server)

| Phase | Time | Notes |
|-------|------|-------|
| Parse (acorn) | ~2.5s | One-time |
| Phase 1-2g (static) | ~4.3s | Fully O(n) |
| Phase 3 (math) | 0s | Disabled (>3MB) |
| Phase 4 (LLM, 200 vars) | ~35s | Network-bound, Opus 4.6 |
| Phase 4 (LLM, 5563 vars) | ~30 min | 28 batches × 70s |
| beautify (prettier) | ~8s | Optional |

---

## File Structure

```
bin/cli.js              — Commander CLI (rename, recover, beautify, split, index)
src/passes/
  renamer.js            — Core: all 7 analysis phases (~2,580 lines, v6)
  beautifier.js         — Prettier wrapper
  splitter.js           — Split bundle into modules
src/llm/
  copilot.js            — GitHub Copilot API client (Opus 4.6 preferred)
tests/run.js            — 28 test cases (node:test runner)
seeds/
  copilot-app.seeds.json — 9,131 seeds for Copilot bundle
docs/
  ANALYSIS_METHODS.md   — This file
  COVERAGE_LOG.md       — Historical coverage measurements
```
