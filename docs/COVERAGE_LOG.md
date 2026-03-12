# Coverage Measurement Log

All measurements on `app.stripped.js` (15.5MB GitHub Copilot bundle, 18,066 bindings).
`static` = no seeds, no LLM. `+seeds` = with `copilot-app.seeds.json` (9,131 entries).

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
