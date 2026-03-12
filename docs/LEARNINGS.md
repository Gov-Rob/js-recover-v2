# js-recover Learnings & Patterns

Patterns and insights accumulated from deobfuscating the GitHub Copilot bundle
(app.stripped.js, 15.5MB, 18,066 bindings). Guides future analysis improvements.

---

## Source Pattern Taxonomy (Copilot bundle)

### Distribution of minified var init patterns

| Pattern | Count | % | Best Strategy |
|---------|-------|---|---------------|
| Function declarations/expressions | ~7,200 | 40% | Usage index (call patterns) |
| Object/undefined init | ~3,800 | 21% | Shape analysis |
| Constructor calls (`new X()`) | ~2,100 | 12% | scoreInit CTOR_CALLS |
| Primitive literals (numbers) | ~1,400 | 8% | Math analysis (worker threads) |
| Symbol.for() | 823 | 4.6% | symbolKeyToName (v6) |
| String literals | ~800 | 4.4% | stringLiteralToName (v6) |
| Class declarations | ~97 | 0.5% | ClassDeclaration visitor (v6) |
| RegExp literals | ~310 | 1.7% | rePattern (v6) |
| require() / import() | ~450 | 2.5% | Module pattern matching |
| Unknown/other | ~1,081 | 6% | LLM naming |

### Naming accuracy by method (empirical)

| Method | Precision | Recall | Notes |
|--------|-----------|--------|-------|
| CTOR_CALLS (new Map etc.) | ~99% | High | Exact pattern match |
| Symbol.for() extraction | ~95% | High | Key parsing very reliable |
| Usage index (streams/events) | ~90% | Medium | Some false positives on generic `.on()` |
| Shape rules | ~85% | Medium | Requires 2+ property matches |
| Prop aggregation | ~75% | High | Lower precision, higher recall |
| String literal naming | ~80% | Low | Only descriptive strings qualify |
| LLM (Opus 4.6) | ~88% | Very high | Best for context-dependent vars |
| Seeds | ~100% | Varies | Gold standard but bundle-specific |

---

## Key Source Patterns Found in Copilot Bundle

### Pattern: undici HTTP client Symbol.for keys
```js
var Dan = Symbol.for("undici.error.UND_ERR");
var zan = Symbol.for("undici.error.UND_ERR_CONNECT_TIMEOUT");
var Pan = Symbol.for("undici.error.UND_ERR_HEADERS_TIMEOUT");
```
→ Lesson: `Symbol.for()` keys are semantically rich. Extract them with high confidence.

### Pattern: Error class hierarchy
```js
class Nmt extends Error { constructor(msg, options) { ... } }
class vSe extends Nmt { ... }
```
→ Lesson: ClassDeclaration with `extends Error` is always a safe `errClass` (score 9).

### Pattern: Module-level constants
```js
var K_FOO = "FOO";    // ALL_CAPS string → constant
var K_key = "key.sub.path";  // dotted path → config key
var connectTimeoutMsg = "Connect Timeout Error"; // phrase → message
```
→ Lesson: String init type strongly predicts semantics. Multi-word phrases → `Msg`.

### Pattern: Event emitter boilerplate (very common)
```js
var Rmt = class extends EventEmitter {};
var wmt = new Rmt();
wmt.on('error', fn);
wmt.emit('data', chunk);
```
→ Lesson: If shape has `.on/.emit` AND extends EventEmitter → score 10 override.

### Pattern: Numeric flags/bitmasks
```js
var Emt = 0x80 | 0x40;  // → bitmask/flags
var Wmt = 1 << 16;      // → bitFlag
```
→ Future: math worker should detect bitwise operations on small integers.

---

## Common Naming Collisions & Fixes

### Problem: `fn_2`, `fn_3` ... `fn_847`
When 800+ vars all get `fn` from usage typing, dedup creates ugly suffixes.
**Fix**: Use more specific usage signals (e.g. `asyncFn`, `callbackFn`, `handlerFn`).

### Problem: `classDef_123`
940 class vars named `classDef` produces ugly output.
**Future fix**: Look at class body methods to extract semantic name:
```js
class X {
  connect() {}  // → Connector
  parse() {}    // → Parser
  emit() {}     // → Emitter
}
```

### Problem: `obj` swamps the type pool
Property aggregation often resolves to `obj` for generic objects.
**Fix threshold**: Require propAggScore >= 5 to use propAgg name (currently 4).

---

## LLM Prompting Patterns (Opus 4.6)

### What works well
```
Context: Multi-occurrence snippets joined with " | "  
Format:  "minVar → semantic_name" per line
Batch:   200 vars per call (safe for Opus 128K window)
Ask:     Single word/identifier, no explanation
```

### What doesn't work
- Sending full function bodies (too many tokens, irrelevant noise)
- Single occurrence context (LLM needs to see multiple uses)
- Asking for comments/explanation (wastes output tokens)

### Prompt structure that works
```
You are a JavaScript deobfuscator. Given minified variable names and their
source context, provide the best semantic name (single valid JS identifier).

Format each answer as: minVar → semanticName

Variables:
bmt (Symbol.for("nodejs.rejection")) | bmt = Symbol.for("nodejs.rejection") | process.on(bmt, ...)
→ nodeRejectionSym

Dan (Symbol.for("undici.error.UND_ERR")) | if (err[Dan]) throw err
→ undiciErrSym
```

---

## Architecture Insights

### Why O(n) matters at 15.5MB
- v4 `applyRenameMap` was O(n²): for each rename, re-scan entire source string.
  At 18K renames × 15.5MB = 279GB of string operations → took 45+ minutes.
- v5 fix: build single regex `/(mangled1|mangled2|...)/g` with word boundaries,
  replace in one pass → 4.3 seconds total.

### Why workers are disabled for large files
- acorn parse creates AST = ~3× source size in memory
- 15.5MB source → ~46MB AST
- Workers need to serialize/deserialize → 46MB × n_workers IPC overhead
- Solution: single-threaded for >3MB, workers only for <3MB files

### Symbol table approach
- `bindings` Map: `name → {initName, initScore, usageType, usageScore, propAggType, ...}`
- Each pass adds/updates fields; final candidate selection picks highest-scoring signal
- This layered approach allows graceful degradation: no single signal is required

---

## Future Improvement Roadmap

### High-impact, low-effort
1. **Scope-aware param naming**: Promise `(resolve, reject)` → always name these
2. **Method chain inference**: if `x` is called like `.pipe().filter().map()` → `arrayChain`
3. **Template literal content**: extract variable from `` `${x} bytes` `` → `x` = count/size

### Medium-impact
4. **Class body method analysis**: parse class methods to infer class purpose
5. **Tighter `obj` threshold**: require score 5 for propAgg (currently 4)
6. **Better `fn` specialization**: asyncFn vs syncFn vs callbackFn vs handlerFn

### High-effort, high-reward
7. **Cross-bundle seed transfer**: seeds from one Copilot version → next version (80%+ reuse)
8. **Incremental analysis**: cache static analysis result, only re-run LLM on changed vars
9. **Graph community detection**: cluster co-occurring vars, name cluster centroids with LLM
