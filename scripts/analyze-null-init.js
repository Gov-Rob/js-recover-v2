import { buildRenameMap } from '../src/passes/renamer.js';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const acorn = require('acorn');
const walk = require('acorn-walk');

const src = readFileSync('/root/copilot-src/app.stripped.js','utf8');
const {map, stats} = await buildRenameMap(src, {llm:false, workers:false});

const namedVars = new Set(Object.keys(map));
const ast = acorn.parse(src, {ecmaVersion:2022, sourceType:'module'});
const isMinified = n => n && /^[a-zA-Z][a-zA-Z0-9]{1,3}$/.test(n);

// Find null-init uncertain vars
const nullInits = new Set();
walk.simple(ast, {
  VariableDeclarator(node) {
    const v = node.id && node.id.name;
    if (!v || !isMinified(v) || namedVars.has(v)) return;
    if (!node.init) nullInits.add(v);
  }
});

// Now find their assignments
const assignCounts = {};
const assignSamples = {};
walk.simple(ast, {
  AssignmentExpression(node) {
    const lhs = node.left && node.left.name;
    if (!lhs || !nullInits.has(lhs)) return;
    const t = node.right ? node.right.type : 'null';
    let key = t;
    if (t === 'CallExpression') {
      let cn = '?';
      if (node.right.callee && node.right.callee.name) cn = node.right.callee.name;
      else if (node.right.callee && node.right.callee.type === 'MemberExpression') {
        const meth = node.right.callee.property && node.right.callee.property.name;
        cn = meth ? 'mem.'+meth : 'mem';
      }
      key = 'Call:' + cn;
    }
    assignCounts[key] = (assignCounts[key]||0)+1;
    if (!assignSamples[key]) {
      assignSamples[key] = lhs + ' = ' + src.slice(node.right.start, Math.min(node.right.start+60, node.right.end)).replace(/\n/g,' ');
    }
  }
});

console.log('Null-init uncertain vars:', nullInits.size);
console.log('\n=== ASSIGNMENT TYPES FOR NULL-INIT UNCERTAIN VARS ===');
const sorted = Object.entries(assignCounts).sort((a,b)=>b[1]-a[1]).slice(0,25);
for (const [k,c] of sorted) {
  const s = assignSamples[k] || '';
  console.log(k.padEnd(28), c, ' eg:', s.slice(0,70));
}
