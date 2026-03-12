# js-recover — Key Method Reference

This document covers the primary public and internal functions used across the rename pipeline.
All functions in `src/passes/renamer.js` unless otherwise noted.

---

## `buildRenameMap(source, opts)`

**File:** `src/passes/renamer.js`  
**Exported:** yes (`export async function`)

### Signature

```js
export async function buildRenameMap(source, opts = {}) → Promise<{ map, stats }>
```

### Parameters

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `source` | `string` | — | Full minified JS source text |
| `opts.llm` | `boolean` | `!!process.env.GH_TOKEN` | Enable LLM pass (Pass 3) |
| `opts.llmBatchSize` | `number` | `15` | Override batch size (overridden by model profile) |
| `opts.workers` | `boolean` | `true` for 200K–3MB files | Enable worker-thread parallelism for math hints |
| `opts.minConfidence` | `number` | `3` | Minimum score to commit a static name |
| `opts.seedsFile` | `string` | `null` | Path to a `{ mangled: semantic }` JSON seeds file |
| `opts.seeds` | `object\|string` | — | Pre-loaded seeds dict, or path string (loaded lazily) |

### Returns

```js
{
  map:   { [mangled: string]: string },  // complete rename dictionary
  stats: { total, static, llm, graph, … }
}
```

### Purpose

Main entry point for the entire rename pipeline. Parses `source` with acorn, runs all static
phases (1–3.17), dispatches uncertain bindings to the LLM pass if enabled, then runs the graph
pass on anything still unresolved. Returns a complete `{ mangled → semantic }` map and a stats
object for reporting.

### Example

```js
import { buildRenameMap } from './src/passes/renamer.js';
import { readFileSync } from 'fs';

const source = readFileSync('copilot.js', 'utf8');
const { map, stats } = await buildRenameMap(source, {
  llm: true,
  seedsFile: './seeds/copilot-seeds.json',
});
console.log(`Renamed ${stats.total} bindings`);
// → Renamed 19,724 bindings
```

---

## `extractContextMulti(source, name, n, maxChars)`

**File:** `src/passes/renamer.js`  
**Exported:** no (internal)

### Signature

```js
function extractContextMulti(source, varName, maxOcc = 3, radius = 500) → string
```

### Parameters

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `source` | `string` | — | Full source text to search |
| `varName` | `string` | — | Mangled identifier to locate |
| `maxOcc` | `number` | `3` | Maximum number of distinct occurrences to collect |
| `radius` | `number` | `500` | Characters of context around each match |

### Returns

Up to `maxOcc` distinct snippets joined by `' | '`. Each snippet is at most 240 characters after
normalising whitespace.

### Purpose

Produces richer LLM context than a single-occurrence excerpt. By collecting up to three
*distinct* surrounding code regions, the prompt gives the model multiple usage sites to reason
from, improving name quality for variables that appear in several different roles.

### Example

```js
const ctx = extractContextMulti(source, 'Ae', 3, 500);
// → "const Ae = require('vscode'); ... | Ae.window.showMessage(...) | return new Ae.Uri(...)"
```

---

## `unique(name)`

**File:** `src/passes/renamer.js` (inner function inside `buildRenameMap`)  
**Exported:** no (closure-scoped)

### Signature

```js
function unique(base) → string
```

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `base` | `string` | Desired semantic name (may be any string) |

### Returns

`base` if not yet taken, otherwise `base_2`, `base_3`, … — the first available suffix variant.
The name is also sanitised through `toIdentifier()` and truncated to 32 characters before the
collision check.

### Purpose

Prevents two distinct mangled variables from receiving the same output identifier. Because
multiple factory closures in a bundle may independently shadow the same module (e.g., both map
to `pathModule`), suffix deduplication keeps every output name unique while preserving the
semantic root visible to developers.

### Example

```js
unique('pathModule')  // → 'pathModule'   (first occurrence)
unique('pathModule')  // → 'pathModule_2' (second occurrence)
unique('pathModule')  // → 'pathModule_3'
```

---

## `screamToCamel(str)`

**File:** `src/passes/renamer.js` (inner function, Phase 3.14)  
**Exported:** no (closure-scoped)

### Signature

```js
const screamToCamel = (s: string) → string
```

### Purpose

Converts a `SCREAMING_SNAKE_CASE` constant name (as found in `MemberExpression` properties like
`Node.TEXT_NODE`) into a `camelCase` identifier suitable for use as a variable name.

### Algorithm

Split on `_`, lowercase every word, capitalise the first letter of each word except the first.

### Example

```js
screamToCamel('TEXT_NODE')          // → 'textNode'
screamToCamel('MAX_BUFFER_SIZE')    // → 'maxBufferSize'
screamToCamel('CONNECT_TIMEOUT')    // → 'connectTimeout'
```

---

## `extractConstantName(node)`

**File:** `src/passes/renamer.js` (inner function, Phase 3.14)  
**Exported:** no (closure-scoped)

### Signature

```js
function extractConstantName(node: AcornNode) → string | null
```

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `node` | `AcornNode` | An `AssignmentExpression` node from the acorn AST |

### Returns

A `SCREAMING_SNAKE_CASE` property name if found, or `null` if the assignment chain contains no
such constant.

### Purpose

Phase 3.14 targets patterns like:

```js
var x = x = Ph.TEXT_NODE = 3
```

The right-hand side is a chain of `AssignmentExpression` nodes. `extractConstantName` walks the
chain recursively — trying `node.left.property.name` first (must match `/^[A-Z][A-Z0-9_]{3,}/`),
then descending into `node.right` and `node.left` — until it either finds a SCREAMING_SNAKE
constant name or exhausts the chain.

### Example

```js
// AST for: var q = q = Node.ELEMENT_NODE = 1
extractConstantName(assignExprNode)
// → 'ELEMENT_NODE'

// which is then converted:
screamToCamel('ELEMENT_NODE')
// → 'elementNode'
```

---

## `llmNameBatch(batch)`

**File:** `src/llm/copilot.js`  
**Exported:** yes (`export async function`)

### Signature

```js
export async function llmNameBatch(batch: Array<{ name: string, context: string }>)
  → Promise<{ [mangled: string]: string }>
```

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `batch` | `Array<{name, context}>` | Uncertain variables with surrounding source context |
| `batch[i].name` | `string` | Mangled identifier (e.g. `'Ae'`) |
| `batch[i].context` | `string` | Source excerpt (truncated to `profile.contextPerVar` chars) |

### Returns

A partial rename map `{ mangled → semantic }` containing only the variables the model could
confidently name. Entries where the model returned `null`, or where the output failed the
identifier regex `/^[a-zA-Z_$][a-zA-Z0-9_$]{1,30}$/`, are omitted.

### Purpose

Core LLM call for Pass 3. Sends a structured prompt to the Copilot Chat API asking the model to
produce camelCase names for each variable given its context. The batch size and context budget are
governed by the active model's profile (see Architecture §4). Auth is handled transparently via
`getToken()`.

### Example

```js
import { llmNameBatch } from './src/llm/copilot.js';

const result = await llmNameBatch([
  { name: 'Ae', context: 'const Ae = require("vscode"); Ae.window.showMessage(...)' },
  { name: 'kf', context: 'kf = new Map(); kf.set("auth", token)' },
]);
// → { Ae: 'vscode', kf: 'authMap' }
```

---

## `graphPass(source, uncertain, map, opts)`

**File:** `src/passes/graph.js`  
**Exported:** yes (`export async function`)

### Signature

```js
export async function graphPass(
  source:       string,
  uncertainVars: string[],
  existingMap:   Record<string, string>,
  opts:          { llm?, propagate?, snapshotTag?, seedsPerCluster? }
) → Promise<{ map: Record<string, string>, stats: object }>
```

### Parameters

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `source` | `string` | — | Full source text (used for context extraction) |
| `uncertainVars` | `string[]` | — | Mangled names that neither static nor LLM passes resolved |
| `existingMap` | `object` | `{}` | Already-resolved names (used to anchor graph edges) |
| `opts.llm` | `boolean` | `!!GH_TOKEN` | Enable LLM naming of seed nodes |
| `opts.propagate` | `boolean` | `true` | Propagate seed names to graph neighbours |
| `opts.snapshotTag` | `string` | `jsr_<timestamp>` | HelixHyper snapshot label |
| `opts.seedsPerCluster` | `number` | `3` | Seeds selected per community |

### Returns

```js
{
  map: { [mangled]: string },  // new names resolved by graph pass
  stats: {
    graphNodes, communities, seeds,
    llmNamed, propagated, total, error?
  }
}
```

### Purpose

Implements Pass 4 (Phase 5) of the rename pipeline using HelixHyper as the graph backend.
The six-step internal workflow:

1. **`analyzeRelationships(source)`** — build a co-occurrence edge list from the source AST
2. **`buildHelixGraph(...)`** — push nodes + edges into HelixHyper MCP
3. **`analyzeHelixGraph()`** — run PageRank + community detection via HelixHyper analytics
4. **`selectSeeds(...)`** — pick the highest-centrality uncertain variable per community
5. **`nameSeeds(...)`** — send seeds to `llmNameBatch` for LLM naming
6. **`propagateNames(...)`** — spread named seeds to their graph neighbours by edge weight

The graph approach is particularly effective for variables that cluster around a shared domain
(e.g., all HTTP-related helpers in one community) where naming one unlocks the neighbours.

### Example

```js
import { graphPass } from './src/passes/graph.js';

const { map, stats } = await graphPass(source, stillUncertain, partialMap, {
  llm: true,
  propagate: true,
  seedsPerCluster: 3,
});
console.log(`Graph resolved ${stats.total} (${stats.llmNamed} LLM + ${stats.propagated} propagated)`);
// → Graph resolved 312 (48 LLM + 264 propagated)
```
