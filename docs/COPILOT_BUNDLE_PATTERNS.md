# Copilot Bundle Patterns — Reverse Engineering Reference

> Observations from analyzing `app.stripped.js` (15.5MB, 18,065 declared bindings)
> This is the GitHub Copilot VSCode extension bundle, built with webpack5 + esbuild.

---

## Bundle Structure

```
app.stripped.js
├── webpack runtime (~2000 lines)
│   ├── __webpack_require__
│   ├── chunk loading machinery
│   └── module registry
├── ~800 webpack modules (IIFE wrapped)
│   ├── React + React-DOM (~150 modules)
│   ├── Copilot core logic (~400 modules)
│   ├── Language server client (~100 modules)
│   └── VS Code API bridge (~150 modules)
└── Entry point initialization
```

---

## Minification Patterns

### Variable Naming Tiers (by frequency)

| Tier | Length | Examples | Source |
|------|--------|---------|--------|
| Ultra-short | 1 char | `e`, `t`, `r`, `n` | Terser loop vars → ALWAYS_SKIP |
| Short | 2 char | `de`, `It`, `Rn` | Imported module bindings |
| Medium | 3-4 char | `Xbt`, `myn`, `jpn` | Local scope vars, state |
| Long-short | 5-7 char | `UCe`, `bgn`, `ggn` | Complex local state |

### Suffix Clustering (learned from 6,000 LLM names)

| Suffix | Pattern | Inferred meaning |
|--------|---------|-----------------|
| `*n` | `myn`, `jpn`, `Mhn` | Node references, naming contexts |
| `*t` | `kDt`, `Hbt`, `Vbt` | Type objects, transition states |
| `*r` | `BAr`, `QZr`, `Pmr` | Reducer functions, ref objects |
| `*e` | `UCe`, `aKe`, `mme` | Error handlers, element refs |
| `*o` | `sWo`, `Ewo`, `C3o` | Options objects, observers |
| `*s` | `Rze`, `Ikt` | Status flags, service instances |
| `*Map` | `*Map` | Registry/hash map objects |
| `*Fn` | `*Fn` | Callback functions |
| `*Ref` | `*Ref` | React useRef values |

### Common Initialization Patterns

```js
// Pattern 1: Module namespace import (IMPORTED — not in GAP_SEEDS)
var de = e(12345);          // → React internals namespace

// Pattern 2: Destructured import
var { useState: It } = de;  // → React.useState alias

// Pattern 3: Webpack chunk reference
var Xbt = __webpack_require__.e(123); // → chunk load promise

// Pattern 4: Config/options object
var mQn = { threshold: 0.8, debounce: 300 }; // → menuQueryOptions

// Pattern 5: Class instance
var jpn = new EventEmitter(); // → jsonParserNode (misnamed; actually event bus)

// Pattern 6: React hook result
var [Mhn, setMhn] = useState(null); // → modalHandlerNode, setModalHandlerNode
```

---

## Phase Coverage Analysis

### Why 80%+ is Hard to Reach with Static Only

Static phases (1-3) cover:
- Variables initialized to string literals ✓
- Variables initialized to `new Constructor()` ✓
- Variables used as specific type (array, object, promise) ✓
- Variables destructured from known objects ✓

Static phases FAIL on:
- Variables initialized to other variables (`var a = b`) — alias chains
- Variables initialized to opaque function calls (`var a = f()`)
- Variables used only as pass-through (`f(a)` with unknown `f`)
- Single-use temporaries with no semantic context

GAP_SEEDS fills the second category. The remaining ~5% after full seeding
will be true unknowns requiring full call-graph analysis.

---

## Imported vs Declared Bindings

**Critical distinction**: Some high-frequency minified names are IMPORTED
(e.g., from webpack module registry) not DECLARED in the local scope.

```js
// DECLARED — enters AST walk, can reach GAP_SEEDS
var Xbt = something;

// IMPORTED via webpack — NOT a declared binding
var de = __webpack_require__(12345);
// de is used everywhere but isMinified() never sees it as uncertain
// because it maps to the external module, not a local declaration
```

**High-freq imported vars** (appear in source, NOT in uncertain list):
- `de` → likely React namespace
- `It` → likely useState or React hook
- `Rn` → likely ReactDOM or renderer
- `Ot`, `Zt` → likely other React APIs

These must be handled via PROP_MAP entries or manual annotation.

---

## Entropy Analysis

Shannon entropy of minified names:
- 2-char names: H ≈ 3.2 bits → low info, LLM needs more context
- 4-char names: H ≈ 5.8 bits → moderate, LLM can often guess from suffix
- 6-char mixed: H ≈ 7.1 bits → higher, often has meaningful structure

**Practical implication**: Longer minified names tend to have better LLM
acceptance rates because they carry more implicit information about their
original structure (e.g., `Xbt` vs `fooBar123` — the latter suggests
a generated temp while the former suggests a meaningful object).

---

## LLM Prompt Engineering

Best prompt structure (evolved over 80+ batches):

```
Expert JS reverse engineer. Return ONLY raw JSON object mapping each
minified name to a descriptive camelCase name. No markdown.

Example: {"abc": "myFunction"}

### varName
<initialization context>
<assignment context>
<call-site context>
```

Key learnings:
- **"No markdown"** is essential — prevents ```json fences that break parsing
- **camelCase** constraint prevents snake_case or PascalCase hallucinations
- **Example** line dramatically reduces format errors
- **3 context snippets max** per var — more context doesn't improve quality
- **Temperature 0.1** — deterministic naming, less creative hallucination
