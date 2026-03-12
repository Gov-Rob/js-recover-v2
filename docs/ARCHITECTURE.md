# js-recover v6.17 — System Architecture

## 1. Overview

**js-recover** is a static + AI-assisted deobfuscator for minified JavaScript bundles. It takes a
Terser/esbuild/rollup output where every variable is a 1–7 character mangled name and recovers
meaningful, camelCase identifiers through a five-pass pipeline.

**Target benchmark:** GitHub Copilot's production bundle (`copilot.js`, 15.5 MB, 20,335 unique
bindings). The current pipeline achieves **97% coverage** — 86.6% resolved by static analysis
alone, with the remaining ~13% handled by LLM + graph passes.

---

## 2. Pipeline

The pipeline is invoked as a single async call (`buildRenameMap(source, opts)`) and runs five
sequential passes, each consuming the output of the previous:

```
┌──────────────┐    ┌───────────────┐    ┌───────────────┐    ┌──────────────┐    ┌────────┐
│  Pass 1      │→   │  Pass 2       │→   │  Pass 3       │→   │  Pass 4      │→   │ Pass 5 │
│  Beautify    │    │  Static Rename│    │  LLM Rename   │    │  Graph Rename│    │ Index  │
│  (acorn)     │    │  (phases 1–   │    │  (Opus 4.6,   │    │  (HelixHyper,│    │        │
│              │    │   3.17)       │    │   auto-batch) │    │   Phase 5)   │    │        │
└──────────────┘    └───────────────┘    └───────────────┘    └──────────────┘    └────────┘
```

### Pass 1 — Beautify

Input source is parsed with `acorn` and pretty-printed before any analysis. This normalises
whitespace, expands compressed statements, and makes subsequent regex-free AST walks reliable.
acorn was chosen over Babel because it is significantly smaller, has no transpile step, and
produces a clean ESTree-compatible AST without Babel's plugin overhead (see §5).

### Pass 2 — Static Rename (Phases 1–3.17)

A multi-phase deterministic renamer resolves every binding it can using only the AST.
No network calls. Runs synchronously in O(n) time relative to binding count.
Phases are detailed in §3.

### Pass 3 — LLM Rename (Copilot Opus 4.6, auto-batch)

Bindings that static analysis marks *uncertain* (confidence < 3) are batched and sent to the
GitHub Copilot Chat API. The active model is auto-selected (Opus 4.6 preferred) and batch size
is tuned per model to stay within context limits. See §4.

### Pass 4 — Graph Rename (HelixHyper co-occurrence, Phase 5)

Variables still unresolved after the LLM pass are analysed through a co-occurrence graph built in
HelixHyper. Community detection (PageRank) identifies clusters; the highest-centrality member of
each cluster is sent to the LLM as a *seed*, then the name propagates to neighbours.

### Pass 5 — Index (symbol map generation)

The completed `{ mangled → semantic }` map is written to `symbol-map.json` and optionally used
by the indexer pass (`src/passes/indexer.js`) to rewrite the source in place.

---

## 3. Static Analysis Phases

All phases run inside `buildRenameMap`. Each phase walks the acorn AST, attempts to derive a
name for every still-unnamed binding, and emits it through `unique()` to prevent collisions.

| Phase | Pattern matched | Example | Approximate yield |
|-------|----------------|---------|-------------------|
| 1 | Well-known IDs (require strings, globals) | `require('path')` → `path` | ~3,000 |
| 2 | Factory export tracking | `exports.foo = fn` → `foo` | ~1,800 |
| 3.1 | String constant init | `var x = "copilot"` → `copilotStr` | ~600 |
| 3.2 | Constructor name | `new Foo()` → `foo` | ~400 |
| 3.3 | Direct alias | `var x = namedVar` → `namedVarRef` | ~300 |
| 3.4 | Member alias | `var x = named.prop` → `namedProp` | ~250 |
| 3.5 | Require alias | `var x = require('m').k` → `mK` | ~200 |
| 3.6 | 2nd-pass alias | alias-of-alias resolution | ~180 |
| 3.7 | Numeric enum | `{A:0,B:1,C:2}` → `abcEnum` | ~120 |
| 3.8 | Binary flags | `0x1\|0x2\|0x4` → `xFlags` | ~80 |
| 3.9 | Factory-body named call | `x = R(namedFn())` → `namedFnRef` | ~200 |
| 3.10 | Prototype chain | `Foo.prototype.bar` → `fooBar` | ~150 |
| 3.11 | Factory null+assign | `var x=null; x=Oe(named(),1)` → `namedResult` | ~180 |
| 3.12 | IIFE enum (return form) | `(function(){return {A:0}})()` → `aEnum` | ~60 |
| 3.13 | Fluent builder | `.name("copilot")` → `copilot` | ~80 |
| 3.14 | DOM constant chain | `var x=x=Ph.TEXT_NODE=3` → `textNode` | +16 |
| 3.15 | Misc semantic | TextDecoder IIFE, `__extends`, LogExpr | +9 |
| 3.16 | Long method call | `obj.getBoundingClientRect()` → `getBoundingClientRectResult` | +4 |
| 3.17 | 3rd-pass alias | After all phases above | +4 |

Phases 3.14–3.17 are targeted micro-passes that fire on the residual uncertain set after 3.1–3.13
and pick up the last few percent before handing off to LLM.

---

## 4. LLM Integration

### Authentication

Pass 3 reads `GH_TOKEN` from the environment. On first use, `fetchCopilotToken(ghToken)` exchanges
it for a short-lived Copilot session token (30-minute TTL). The session token is cached in memory
and transparently refreshed 5 minutes before expiry via `getToken()`. No credentials are written
to disk.

### Model auto-selection

`resolveModel()` calls the Copilot `/models` endpoint and selects the best available model from an
ordered preference list:

```
claude-opus-4.6 → claude-opus-4.5 → claude-sonnet-4.6 → claude-sonnet-4.5 → gpt-4o → gpt-4o-mini
```

The resolved model is memoised for the lifetime of the process.

### Batch sizing strategy

Each model has a profile that controls how many uncertain variables are packed into a single API
call and how many context characters are included per variable:

| Model | Context/var | Batch size | Max output tokens |
|-------|-------------|------------|-------------------|
| claude-opus | 600 chars | 200 vars | 16,000 |
| claude-sonnet | 500 chars | 150 vars | 12,000 |
| gpt-4o | 400 chars | 100 vars | 6,000 |
| gpt-4o-mini | 300 chars | 40 vars | 3,000 |
| (default) | 300 chars | 15 vars | 1,200 |

Opus can therefore resolve the entire uncertain set of a typical bundle in 1–3 API calls rather
than the ~100 calls required with the legacy 15-var default.

---

## 5. Design Decisions

### Why acorn, not Babel?

Babel's parser carries a large plugin system, a transpile layer, and generates a non-standard AST
(with `@babel/types` wrappers). acorn is 40× smaller, produces a pure ESTree AST, and has no
runtime dependencies. Because js-recover never *transforms* code — only reads it — acorn's
read-only speed advantage compounds across every binding in a 15 MB file.

### Why `unique()` suffix deduplication?

Multiple minified variables can legitimately map to the same semantic concept (e.g., two separate
`pathModule` references in different factory closures). Rather than silently colliding or discarding
names, `unique(base)` appends `_2`, `_3`, … to later occurrences. This keeps every output
identifier valid and distinguishable while preserving the semantic root for human readers.

### Why 86.6% is the static ceiling

Static analysis can only name a binding when the AST provides an unambiguous derivation path: a
`require()` string, an `exports.key` assignment, a `new Constructor()`, etc. The remaining ~13%
of bindings are intermediary temporaries, generic accumulator variables, or cross-module aliases
where no local syntactic clue exists. These fundamentally require semantic understanding —
either from an LLM or from the graph's propagation of adjacent names.

### Why not regex?

Regex operates on the raw character stream. Minified JS reuses short names aggressively, so a
pattern like `/\bx\b/` would match loop counters, argument names, and the meaningful variable
simultaneously. AST walks are scope-aware: each binding object (`b`) carries the full set of
reference nodes, preventing false-positive matches across different scopes.
