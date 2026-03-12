# js-recover

**Enterprise JavaScript Source Recovery Tool**

Deobfuscate, unpack and reconstruct minified/bundled JavaScript files.  
Useful when you've lost source, need to audit a dependency, or want to study a minified bundle.

---

## Features

| Pass | What it does |
|------|-------------|
| **Beautify** | Format minified code into readable indented output |
| **Rename** | AST-based semantic variable renaming (slash commands, constructors, string constants) |
| **Split** | Detect and extract modules from webpack4/5, esbuild, rollup and copilot-style bundles |
| **Index** | Build a full symbol index (functions, classes, variables, exports) with line numbers |

Supported bundle formats: `webpack4`, `webpack5`, `esbuild`, `rollup`, `copilot`, `commonjs`

---

## Install

```bash
cd js-recover
npm install
npm link          # makes `js-recover` available globally
```

---

## Usage

### Full pipeline (all passes)

```bash
js-recover recover app.min.js -o ./recovered
```

### Individual passes

```bash
js-recover beautify  app.min.js -o app.pretty.js
js-recover rename    app.min.js --map rename-map.json
js-recover split     app.min.js -o ./modules
js-recover index     app.min.js -o ./out
```

### Options

```
recover [options] <input>
  -o, --output <dir>     Output directory (default: ./recovered)
  --no-beautify          Skip beautification
  --no-rename            Skip AST renaming
  --no-split             Skip module splitting
  --no-index             Skip symbol indexing
  --indent <n>           Indentation spaces (default: 2)
  --verbose              Print stack traces on pass failures
```

---

## Output

```
recovered/
├── app.pretty.js          Beautified source (renames applied)
├── app.renamed.js         Renamed minified source
├── app.rename-map.json    { mangled → semantic } mapping
├── app.symbols.json       Full symbol list with line numbers
├── app.SYMBOLS.md         Human-readable symbol reference table
├── modules/               Extracted bundle modules
│   ├── module_0.js
│   └── ...
└── recovery-report.json   Run metadata and stats
```

---

## Tests

```bash
npm test
```

Tests use Node's built-in `node:test` runner — no external framework.

---

## Notes

- Always runs the AST (rename/index) passes on the **original stripped source**, not on the beautified output.  
  This is required because js-beautify can produce code that isn't valid for AST parsers when `unescape_strings` is on.
- Rename pass only targets likely-minified identifiers (≤6 chars). Long names are never touched.
- Symbol index includes all top-level and nested declarations with their exact line numbers.
