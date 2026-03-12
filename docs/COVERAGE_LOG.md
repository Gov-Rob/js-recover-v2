# Coverage Measurement Log

All measurements on `app.stripped.js` (15.5MB GitHub Copilot bundle, 20,335 bindings).
`static` = no seeds, no LLM. `+seeds` = with `copilot-app.seeds.json` (9,131 entries).

---

## 2026-03-15 — v6.8 R/S Factory Body Deep-Scan

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | 16,665 | 20,335 | **82.0%** |

Changes from v6.7 → v6.8 (+64 names):
- R()/S() factory body scan enhanced: detects `Ce("node:xxx")` imports, destructured long-name imports (≥8 chars), `Symbol("name")` calls
- Factory scan priority: Ce-import (9) > destructured key (7) > Symbol (6) > export assignment (4)
- Removed old shallow scan; replaced with priority-sorted candidate list

Commit: pending

---

## 2026-03-15 — v6.7 Long-Prop MemberExpr, BinaryExpr/ConditionalExpr/FunctionExpr

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | 16,601 | 20,335 | **81.6%** |

Changes from v6.6 → v6.7 (+184 names):
- `scoreInit()` MemberExpression: long camelCase props (≥5 chars) used directly as name (score 7)
  `x = obj.extractBody` → `extractBody`; action prefixed props (`getXxx`, `createXxx`) → score 8
- `scoreInit()` string-arg factory: strip `[[bracket]]` wrapping before testing PascalCase
- `scoreInit()` regex-arg: `fn(/pattern/)` → `patternRegex` (score 4)
- `scoreInit()` array-arg (≥2 elems): `arrayDef` (score 3)
- `scoreInit()` ConditionalExpression: `a?b:c` → score both branches, pick higher (new case)
- `scoreInit()` BinaryExpression: string concat → `concatStr`, comparisons → `boolResult`, arithmetic → `numResult`
- `scoreInit()` FunctionExpression/ArrowFunctionExpression: `async→asyncFn`, `generator→generatorFn`, single-expr body recurse

Commit: `71e6428`

---

## 2026-03-15 — v6.6 Schema Builders, String-Arg Factories, Extended MemberPropMap

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | 16,417 | 20,335 | **80.7%** |

Changes from v6.5 → v6.6 (+816 names):
- `scoreInit()` CallExpression: Zod/Yup/Joi schema builder method detection
  `obj.object({key:...})` → `keySchema`; `obj.extend({...})` → `firstKeySchema`; `obj.union([])` → `unionSchema`
- `scoreInit()` CallExpression: first-string-arg factory `fn("ClassName")` → `classNameDef`
  (e.g. `hn("$ZodError", base)` → `zodErrorDef`)
- `scoreInit()` CallExpression: object-shape first-key `fn({key:...})` → `keyConfig`
- `scoreInit()`: UnaryExpression (`!x→negated`, `-x→negNum`, `typeof→typeStr`, `void→undefinedVal`)
- `scoreInit()`: AwaitExpression (recurse on argument, fallback `awaited`)
- `scoreInit()`: ChainExpression (recurse on inner expression `x?.y`)
- MEMBER_PROP_MAP: +50 common value properties (length/count, status, message, url, path, etc.)
- MemberPropMap score: 6 → 5 (property name alone less reliable than method calls)

Commit: `fc03d3c`

---

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | 15,601 | 20,335 | **76.7%** |
| static + seeds | ~19,984 | 20,335 | ~98.3% |

Changes from v6.4 → v6.5 (+774 names):
- `scoreInit()`: `AssignmentExpression` case recurses on `.right` (catches `var x = y = z`)
- `scoreInit()`: `LogicalExpression` case scores both branches, picks higher confidence
- `buildAliasIndex`: `Oe(y)` / `Ce(y)` module interop wrappers propagate first-arg alias
- `buildAliasIndex`: lazy callee pattern `var x = rd()` propagates alias from callee (`rd`)

Commit: `19c25c7`

---

## 2026-03-13 — v6.4 scoreInit Expansion

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | 14,827 | 20,335 | **72.9%** |
| static + seeds | ~19,984 | 20,335 | ~98.3% |

Changes from v6.3 → v6.4 (+321 names):
- `scoreInit()` `NewExpression`: handle `new obj.Ctor()` via `callee.property.name`
- `scoreInit()` new `MemberExpression` case: `var x = y.PROP` with `MEMBER_PROP_MAP`
- `scoreInit()` new `Identifier` case: global built-in alias detection (30+ built-ins)
- `scoreInit()` `CallExpression`: R()/S() lazy module factory export key scanning
- Phase 3.5: name-propagation alias pass after Phase 3 map is built

Commit: `e17dbe8`

---

## 2026-03-12 — v6 Phase 2g (Symbol.for / Class / String-literal)

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | 12,177 | 18,066 | **67.4%** |
| static + LLM sample (100 vars, Opus 4.6) | 12,275 | 18,066 | 67.9% |
| static + seeds | ~17,748 | 18,066 | ~98.2% |
| static + full LLM (5,563 vars, Opus) | pending | 18,066 | ~85%+ est |

New renames introduced by v6:
- Symbol.for() renames: **823** vars → `sym_*` names
- Class declarations: **940** vars → `errClass` / `subClass` / `classDef`
- String literal Msg: **23** vars → `*Msg` names
- Net new static names (v5→v6): **+411**

Commit: `98f4272`

---

## 2026-03-11 — v5 O(n) Rearchitecture + Seeds Pipeline

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | 11,766 | 18,065 | **65.1%** |
| static + seeds | 17,740 | 18,065 | **98.2%** |

Key fix: `applyRenameMap` was O(n²) → O(n) via regex-replace-all.
Seeds extracted via multi-pass LLM sessions, 9,131 entries.

---

## 2026-03-09 — v4 Shape Rules + Prop Aggregation

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | ~10,500 | 18,065 | ~58% |

Added: SHAPE_RULES clusters, buildPropAggScore, destructuring analysis.

---

## 2026-03-06 — v3 Baseline

| Mode | Named | Total | Coverage |
|------|-------|-------|----------|
| static | ~8,100 | 18,065 | ~45% |

---

## What "coverage" means

A binding is "covered" (named) when the final candidate name passes:
1. `candidate !== null`
2. `confidence >= minConfidence` (default: 3)
3. `candidate !== mangled` (no identity mapping)
4. The name passes `unique()` dedup (appends `_2`, `_3` etc. for collisions)

Uncertain bindings go to the LLM pass or remain with their minified name.
