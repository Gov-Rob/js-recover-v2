import { buildRenameMap } from '../src/passes/renamer.js';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const acorn = require('acorn');
const walk = require('acorn-walk');

const src = readFileSync('/root/copilot-src/app.stripped.js','utf8');
const {map, stats} = await buildRenameMap(src, {llm:false, workers:false});
console.log('Named:', stats.total, '/', stats.bindings, '=', (100*stats.total/stats.bindings).toFixed(1)+'%\n');

// namedVars = keys in map (both named and skipped/intentional)
const namedVars = new Set(Object.keys(map));
const ast = acorn.parse(src, {ecmaVersion:2022, sourceType:'module'});

// Only analyze vars that are genuinely minified AND not in map (truly uncertain)
const isMinified = n => n && /^[a-zA-Z][a-zA-Z0-9]{1,3}$/.test(n);

const initCounts = {};
const callMemMethods = {};

walk.simple(ast, {
  VariableDeclarator(node) {
    const v = node.id && node.id.name;
    if (!v || !isMinified(v) || namedVars.has(v)) return;
    const t = !node.init ? 'null' : node.init.type;
    let key = t;
    if (t === 'CallExpression') {
      let cn = '?';
      if (node.init.callee && node.init.callee.name) cn = node.init.callee.name;
      else if (node.init.callee && node.init.callee.type === 'MemberExpression') {
        cn = 'mem';
        const meth = node.init.callee.property && node.init.callee.property.name;
        if (meth) callMemMethods[meth] = (callMemMethods[meth]||0)+1;
      }
      key = 'Call:' + cn;
    }
    initCounts[key] = (initCounts[key]||0)+1;
  }
});

console.log('=== UNCERTAIN BY INIT TYPE (minified only, len>=2) ===');
const sorted = Object.entries(initCounts).sort((a,b)=>b[1]-a[1]).slice(0,20);
for (const [k,c] of sorted) console.log(k.padEnd(25), c);

console.log('\n=== TOP CALL:MEM METHODS ===');
const topMeth = Object.entries(callMemMethods).sort((a,b)=>b[1]-a[1]).slice(0,30);
for (const [m,c] of topMeth) console.log(m.padEnd(30), c);
