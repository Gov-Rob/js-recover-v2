# Gap-Fill Pipeline — Learnings & Best Methods

## Architecture
Iteratively expand `GAP_SEEDS` dictionary in `src/passes/renamer.js` by routing
"uncertain" variable names through an LLM. Each round adds ~120-200 net seeds,
raising static coverage ~0.7-1.2% per round.

## Pipeline Steps

### 1. Extract Unseeded List
```bash
python3 -c "
import json
with open('/tmp/uncertain-exact.json') as f: pool = json.load(f)
with open('/tmp/gap-names-merged.json') as f: merged = json.load(f)
unseeded = [n for n in pool if n not in merged]
print(len(unseeded))
"
```

### 2. Prep Batch Input Files (100 vars/batch, ~130s/100 via regex on 15.5MB src)
```bash
python3 prep-batch.py  # reads uncertain-exact.json + merged, slices unseeded[offset:offset+100]
# outputs /tmp/uncertain-batch{N}.json — list of {name, context[]}
```
**DO NOT use acorn.parse with locations:true — OOM on 15.5MB file.**
Use Python regex patterns:
- `\b(?:var|let|const)\s+<name>\s*=\s*([^;\n]{1,120})`
- `\b<name>\s*\(([^)]{1,80})\)`
- `\b<name>\s*=\s*([^;\n]{1,80})`

### 3. Run LLM Batch (Ollama-first, ~15-20 min/100 vars)
```bash
node /tmp/multi-model-batch.mjs /tmp/uncertain-batch${N}.json /tmp/gap-names-${N}.json
```
**Ollama is the primary LLM** (no quota, unlimited, local):
- Primary model: `mistral-nemo:latest` (best JSON compliance)
- Fallback: `llama3.1:latest`, `mistral:latest`
- Endpoint: `http://127.0.0.1:11434/api/generate`
- Params: `stream:false, temperature:0.1, num_predict:1500`

**GitHub Copilot API notes (quota-limited, use as fallback only)**:
- Business proxy (`proxy.business.githubcopilot.com`) requires `stream:true` and only has code-completion models
- Regular endpoint (`api.githubcopilot.com`) needs session token exchange from `ghu_` token
- `spainion` account token is quota-exhausted; `chaoz-soon` PAT can't use Copilot API

### 4. Filter Raw Output (hallucination guard)
```python
import json, re
batch_keys = set(b['name'] for b in json.load(open(f'uncertain-batch{N}.json')))
merged = json.load(open('gap-names-merged.json'))
merged_keys = set(merged.keys())
seen_vals = set(merged.values())
for k, v in raw.items():
    if k not in batch_keys: continue          # hallucination guard
    if not isinstance(v, str): continue
    if len(v) < 3 or len(v) > 60: continue   # length sanity
    if not re.match(r'^[a-zA-Z_$][a-zA-Z0-9_$]*$', v): continue  # valid JS ident
    if k in merged_keys or v in seen_vals: continue  # no dupes
    merged[k] = v
```
Expected yield: 40-60% of raw names pass filter.

### 5. Inject into renamer.js
Find last GAP_SEEDS entry with regex anchor:
```python
matches = list(re.finditer(r"    '([A-Za-z0-9\$_]{2,6})': '([^']+)',\n  \};", content))
last_m = matches[-1]
```
Insert new block before closing `};`, then fix double-comma artifact:
```python
new_content = re.sub(r"'([^']+)',,", r"'\1',", new_content)
```
Always verify: `node --check src/passes/renamer.js`

### 6. Benchmark
```bash
node --input-type=module -e "
import { buildRenameMap } from './src/passes/renamer.js';
import { readFileSync } from 'fs';
const r = await buildRenameMap(readFileSync('/root/copilot-src/app.stripped.js','utf8'), {llm:false,workers:false});
const s = r.stats;
console.log(\`\${s.static}/\${s.bindings} = \${(s.static/s.bindings*100).toFixed(1)}%\`);
"
```
**buildRenameMap is async** — must use `await` in ES module context.
DO NOT use CJS `require()` — returns `{}`.

## Coverage Milestones
| Checkpoint | Seeds | Coverage | Uncertain |
|-----------|-------|----------|-----------|
| Session start | 5,973 | 81.8% | 3,295 |
| B82-84 | 6,015 | 82.0% | 3,257 |
| B85-87 | 6,153 | 82.8% | 2,790 |
| B88-90 | 6,345 | 83.8% | 2,598 |
| B91-93 | 6,483 | 84.5% | 2,293 |
| B94-96 | 6,650 | 85.5% | 2,129 |
| B97-99 | 6,814 | 86.4% | 2,006 |
| B100-102 | 6,937 | 87.1% | 1,835 |
| B103-106 | 7,108 | 88.0% | 1,835 |
| B107-109 (2nd pass) | 7,267 | **88.9%** | 1,676 |
| Target | ~7,800 | **90%+** | <1,200 |

## Parallelism
Run 3 batches in parallel (separate terminals) to 3× throughput:
```bash
node /tmp/multi-model-batch.mjs /tmp/uncertain-batch88.json /tmp/gap-names-88.json &
node /tmp/multi-model-batch.mjs /tmp/uncertain-batch89.json /tmp/gap-names-89.json &
node /tmp/multi-model-batch.mjs /tmp/uncertain-batch90.json /tmp/gap-names-90.json &
wait
```
Monitor RAM: `free -h` — abort if >96% (32GB system, 91% normal baseline).

## Key Files
| File | Purpose |
|------|---------|
| `src/passes/renamer.js` | Core — GAP_SEEDS dict + buildRenameMap |
| `/tmp/gap-names-merged.json` | Master accumulated LLM seeds |
| `/tmp/uncertain-exact.json` | Authoritative 5,323 uncertain vars (sorted by freq) |
| `/tmp/uncertain-batch{N}.json` | Batch input files (hallucination filter source) |
| `/tmp/gap-names-{N}.json` | Raw LLM output per batch |
| `src/llm/multi-model-batch.mjs` | Ollama-first LLM runner |

## Critical Bugs Fixed
1. **`v.context` is array** → must `.join('\n')` before slicing into prompt
2. **Nested template literals** in `sed -i` replacements → rewrote as `buildPrompt()` function
3. **Double-comma injection** → `re.sub(r"'([^']+)',,", r"'\1',", content)`
4. **`buildRenameMap` is async** → must use `await` (CJS require returns `{}`)
5. **Expired `ghu_` token** → pivot to Ollama (no quota)
6. **Ollama needs `stream:false`** explicitly in request body
7. **Stale benchmark** → always start benchmark AFTER injection completes; each `node` spawn is fresh but a shell running in background at injection time sees old file
8. **Second pass resets offset** → after first pass exhausts 2,129 vars, recompute unseeded list and reset offset to 0 against the new smaller pool

## Second Pass (B107+)
When first pass exhausts its pool (offset > pool size), switch to second pass:
```python
# Always recompute unseeded from scratch:
unseeded = [n for n in uncertain if n not in merged]
# B107 → unseeded[0:100], B108 → unseeded[100:200], etc.
```
Second pass sees ~+0.6-0.9% per 3-batch round as the remaining vars are harder.

## Benchmark Command (Fresh — No Stale Results)
```bash
cd /root/repos/js-recover && node --input-type=module -e "
import { buildRenameMap } from './src/passes/renamer.js';
import { readFileSync } from 'fs';
const r = await buildRenameMap(readFileSync('/root/copilot-src/app.stripped.js','utf8'), {llm:false,workers:false});
const s = r.stats;
console.log(s.static + '/' + s.bindings + ' = ' + (s.static/s.bindings*100).toFixed(1) + '%  uncertain:' + s.uncertain);
" 2>/dev/null
```
Always run in a fresh shell AFTER injection, never as a background job started before injection.

## Static Pattern Seeds (Phase 0 — Pre-LLM)

Before running LLM batches, extract these from the source with pure regex:

### Ce("module") pattern (+26 seeds)
```python
import re
for m in re.finditer(r'\b([A-Za-z0-9_$]{2,6})\s*=\s*Ce\("([^"]{2,30})"\)', src):
    var, mod = m.group(1), m.group(2)
    base = re.sub(r'[^a-zA-Z0-9]', '_', mod).strip('_')
    parts = [p for p in base.split('_') if p]
    name = parts[0] + ''.join(p.capitalize() for p in parts[1:]) + 'Req'
    # try_add(var, name)  # with dedup suffix
```
`Ce` is the bundled `require()` function. Maps `var x = Ce("http")` → `x = httpReq`.

### Wrapped imports (+9 seeds)
```python
for m in re.finditer(r'\b([A-Za-z0-9_$]{2,6})\s*=\s*[A-Za-z_$]+\(Ce\("([^"]+)"\)\)', src):
    var, mod = m.group(1), m.group(2)
    name = re.sub(r'[^a-zA-Z0-9]', '', mod)[:20] + 'Default'
    # try_add(var, name)
```

Combined static patterns yield **35 seeds before any LLM**.

## Coverage Rate Summary
- LLM batches (100 vars): ~50-70 accepted, +0.8-1.0% per 3-batch round
- Static Ce() patterns: 35 seeds, +0.2%
- Diminishing returns after 89% — remaining vars have minimal context
- Estimated ceiling without graph analysis: ~91-92%
| B110-112 + suffix | 7,489 | 90.2% | 1,454 |

### Numeric Suffix Fallback (B110-112 breakthrough)
At 89.1% coverage, B110-112 produced **0 accepted seeds** with original filter.
Root cause: all popular 3-letter name slots were exhausted (`handleRequest`, `fetchData`, etc.).

**Fix**: Added suffix fallback to `filter_batch()` in `gap-fill-inject.py`:
```python
if v in seen_vals:
    for n in range(2, 10):
        candidate = f"{v}{n}"
        if candidate not in seen_vals:
            final_v = candidate; break
    else: continue  # all 9 suffixes exhausted
```
Result: B110-112 went from **0% → 35% yield** (+62 seeds), pushing 89.1% → **90.2%**.

### Key lessons
- LESSON 9: After 89%+, popular names fill up → suffix fallback needed
- LESSON 10: case-insensitive val dedup is wrong; always case-sensitive
