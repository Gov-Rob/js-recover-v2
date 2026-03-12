# js-recover Coverage Log

Benchmark target: `/root/copilot-src/app.stripped.js` (15.5 MB, 20,335 bindings)

---

## v6.17 — LLM Pass (Claude Opus 4.6 via Copilot)
**Coverage: 19,732 / 20,335 = 97.0%**  (static: 17,619 | llm: +2,113 | uncertain: 277)

- LLM pass via GitHub Copilot API (model: claude-opus-4.6)
- Ran on all ~2,390 uncertain vars remaining after static ceiling
- 48 batches × 50 vars → 22 minutes, 2,113 new semantic names
- Committed: `v6.17`

---

## v6.16 — Static Ceiling (Phases 3.14–3.17)
**Coverage: 17,619 / 20,335 = 86.6%**  (static only | uncertain: 2,390)

- Phase 3.14: AssignmentExpression chain DOM constant extraction (+16)
  - Pattern: `var nkt = nkt = Ph.ATTRIBUTE_NODE = 2` → `attributeNode`
  - `screamToCamel()` converts SCREAMING_SNAKE to camelCase
- Phase 3.15: Misc semantic patterns (+9)
  - g1(ICON_CONST, "") → `iconNameIcon`
  - IIFE containing `new TextDecoder` → `textDecoder`
  - LogicalExpression with `.__extends` → `extendsHelper`
- Phase 3.16: Direct-init CallExpression with long method names (+4)
  - `var x = obj.getLongMethodName(...)` → `getLongMethodNameBase`
- Phase 3.17: Third-pass alias propagation (+4)
  - Re-runs alias propagation after new phases to catch newly-named refs
- Committed: `4eb53e5`

---

## v6.15 — Phase 3.13 (Fluent Builder Name Extraction)
**Coverage: 17,586 / 20,335 = 86.5%**

- Phase 3.13: Builder chain `.name("copilot")` → `copilot`, `.category("AI")` → `aiCategory`
- Detects `.name()` / `.title()` / `.summary()` / `.label()` string literals in method chains
- Handles both direct `var x = builder.name("foo")` and factory-body chains

---

## v6.14 — Phase 3.12 (IIFE Numeric Enum Return-Form)
**Coverage: 17,571 / 20,335 = 86.4%**

- Pattern: `var st = (function(){return {A:0,B:1,C:2}})()` → `stBcEnum`
- Complements Phase 3.7 which handles assignment-form enums

---

## v6.13 — Phase 3.11 (Factory-Body Call-Assign + Phase 3.10 Refinements)
**Coverage: 17,558 / 20,335 = 86.3%**

- Phase 3.11: `var x = null; ... x = Oe(namedFn(), 1)` → `namedFnResult`
- Handles factory-body null-init vars later assigned via wrapper calls
- Phase 3.10 refinement: detect `.prototype.constructor` init

---

## v6.12 — Phase 3.9 + 3.10 (Factory Exports + Prototype Chain)
**Coverage: 17,532 / 20,335 = 86.2%**

- Phase 3.9: Factory-body assignment from named call: `x = R(namedFn())` → `namedFnRef`
- Phase 3.10: Prototype chain `x = Foo.prototype.bar` → `fooBar`

---

## v6.11 — Phase 3.7 + 3.8 (Numeric Enum + Binary Flags)
**Coverage: 17,487 / 20,335 = 86.0%**

- Phase 3.7: `var x = {A:0, B:1, C:2}` ObjectExpression with ≥3 numeric values → `xAbcEnum`
- Phase 3.8: `var x = 0x1 | 0x2 | 0x4` binary flags → `xFlags`

---

## v6.10 — Phase 3.6 (Alias Propagation Second-Pass)
**Coverage: 17,442 / 20,335 = 85.8%**

- Phase 3.6: Re-runs alias propagation for vars that are aliases of aliases
- Catches `y = x` after `x` was named in phase 3.5

---

## v6.9 — Phase 3.5 (Import Alias + re-export chains)
**Coverage: 17,381 / 20,335 = 85.5%**

- Phase 3.5: `var x = require('module-name').subkey` → `moduleNameSubkey`
- Handles CJS/ESM re-export aliases in the copilot bundle factory

---

## Earlier Milestones

| Version | Coverage | Key Addition |
|---------|----------|-------------|
| v6.0    | 83.0%    | Worker threads, Acorn-based AST walk |
| v5.0    | 78.5%    | Phase 3 static patterns (string const, constructor name) |
| v4.0    | 72.0%    | Phase 2 (factory scan, export tracking) |
| v3.0    | 63.0%    | Phase 1 (require strings, well-known identifiers) |
| v2.0    | 45.0%    | Regex heuristics (pre-AST) |
| v1.0    | 28.0%    | Naive token pass |

---

## Static Analysis Ceiling Analysis

After v6.16, remaining ~2,390 uncertain vars break down as:

| Init Type | Count | Why Uncertain |
|-----------|-------|--------------|
| `null` | ~370 | Factory-body null-init, no semantic hint |
| `Call:R` | ~306 | Anonymous module factory vars |
| `Call:S` | ~172 | Same pattern, different factory |
| `Literal` | ~163 | Number literals (excluded by design) |
| `MemberExpression` | ~40 | Short props (`value`, `length`) below threshold |
| `FunctionExpression`| ~5  | Anonymous functions on recycled vars |
| `NewExpression` | ~4 | `new Array/Map/Set` on recycled vars |

Static ceiling: **~86.6%** — LLM required for the remaining ~13.4%

## Final State (v6.17)

- Static: 17,619 / 20,335 = **86.6%**
- LLM (Opus 4.6): +2,113 additional names
- **Combined: 19,732 / 20,335 = 97.0%**
- Remaining uncertain: 277 (mostly numeric literals and ultra-short single-use vars)

## v6.19 — 2026-03-06
- **Coverage**: 96.4% (19,608 / 20,335)
- **LLM**: 1,985 names (batchSize=50, contextPerVar=2000, 48 batches)
- **Graph**: 4 names (2 communities)
- **LLM success rate**: 83.1% (improved from 77.8% in v6.17)
- **Change**: Fixed batchSize 80→50 (better attention per var with larger context)
- **Commits**: cefe1c0

## v6.20 — 2026-03-06 ⭐ NEW RECORD
- **Coverage**: 97.8% (19,893 / 20,335)
- **LLM pass 1**: 1,985 names (batchSize=50, contextPerVar=2000)
- **LLM pass 2**: +285 names (aggressive mode, 405 residuals → 284 named, 121 remain)
- **Graph**: 4 names
- **LLM total**: 2,270 names
- **Remaining uncertain**: 121 (loop counters, single-use temps with zero signal)
- **Change**: 2-pass LLM strategy with permissive "aggressive" prompt on residuals
- **Time**: 13m53s total
