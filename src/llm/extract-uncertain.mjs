/**
 * extract-uncertain.mjs — Extract exact uncertain variable list from buildRenameMap
 *
 * USAGE:
 *   node src/llm/extract-uncertain.mjs [source.js] [output.json]
 *
 * OUTPUT:
 *   JSON array of minified var names that:
 *   - Are declared bindings in the source (not imports)
 *   - Pass isMinified() (length 2-7, match pattern, not in ALWAYS_SKIP)
 *   - Are NOT in the static output of buildRenameMap (i.e., all 3 phases failed)
 *
 * This is THE authoritative list for gap-fill batching. Never batch anything
 * outside this list — those vars either already have static names or are skipped.
 *
 * LEARNINGS:
 *   - DO NOT add locations:true to acorn parse options on files >5MB → OOM
 *   - buildRenameMap returns { map, stats } where map is a plain object
 *   - Uncertain = declared binding + passes isMinified() + NOT in map
 *   - Sort by declaration frequency (descending) for max coverage ROI per batch
 */

import { buildRenameMap } from '../passes/renamer.js';
import * as acorn from 'acorn';
import * as walk  from 'acorn-walk';
import { readFileSync, writeFileSync } from 'fs';

const srcPath = process.argv[2] || '/root/copilot-src/app.stripped.js';
const outPath = process.argv[3] || '/tmp/uncertain-exact.json';

console.log(`Reading ${srcPath}...`);
const src = readFileSync(srcPath, 'utf8');

console.log('Running buildRenameMap (static only)...');
const { map: staticMap } = await buildRenameMap(src, { llm: false, workers: false });
const namedKeys = new Set(Object.keys(staticMap));
console.log(`Static map: ${namedKeys.size} vars`);

// isMinified — must match renamer.js definition exactly
const ALWAYS_SKIP = new Set([
  'i','j','k','n','s','e','t','r','x','y','ok','id','fn','cb',
  'el','ms','db','fs','vm','io','os','if','do','in','of','to',
  'is','on','by','at','up','go','no','me','my','we'
]);
function isMinified(name) {
  return name.length >= 2 && name.length <= 7 &&
    !ALWAYS_SKIP.has(name) &&
    /^[a-zA-Z$_][a-zA-Z0-9$_]{1,5}$/.test(name);
}

console.log('Walking AST for declared bindings (no locations, fast)...');
let ast;
try {
  ast = acorn.parse(src, {
    ecmaVersion: 'latest', sourceType: 'module',
    allowHashBang: true, allowImportExportEverywhere: true,
    locations: false,   // CRITICAL: never true on large files
  });
} catch(e) {
  // Fallback: script mode
  ast = acorn.parse(src, {
    ecmaVersion: 'latest', sourceType: 'script',
    allowHashBang: true, locations: false,
  });
}

const declCount = new Map();
const declTypes  = ['VariableDeclarator', 'FunctionDeclaration',
                    'FunctionExpression',  'ArrowFunctionExpression',
                    'ClassDeclaration',    'ClassExpression'];

walk.simple(ast, {
  VariableDeclarator(node) {
    const name = node.id?.name;
    if (name && isMinified(name) && !namedKeys.has(name))
      declCount.set(name, (declCount.get(name) || 0) + 1);
  },
  FunctionDeclaration(node) {
    const name = node.id?.name;
    if (name && isMinified(name) && !namedKeys.has(name))
      declCount.set(name, (declCount.get(name) || 0) + 1);
  },
  // Params
  Function(node) {
    for (const p of node.params || []) {
      const name = p.name || p.left?.name;
      if (name && isMinified(name) && !namedKeys.has(name))
        declCount.set(name, (declCount.get(name) || 0) + 1);
    }
  },
});

// Sort by frequency descending (highest ROI first)
const sorted = [...declCount.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([name]) => name);

writeFileSync(outPath, JSON.stringify(sorted, null, 2));
console.log(`Written ${sorted.length} uncertain vars to ${outPath}`);
