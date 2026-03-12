import { buildRenameMap } from './src/passes/renamer.js';
import { readFileSync } from 'fs';
import acorn from 'acorn';
import * as walkMod from 'acorn-walk';
const walk = walkMod;

const src = readFileSync('/root/copilot-src/app.stripped.js','utf8');
const {map, stats} = await buildRenameMap(src, {llm:false, workers:false});
console.log('Named:', stats.total, '/', stats.bindings, '=', (100*stats.total/stats.bindings).toFixed(1)+'%');

const namedVars = new Set(Object.keys(map));
const ast = acorn.parse(src, {ecmaVersion:2022, sourceType:'module'});
const isMinified = n => n && n.length <= 4 && /^[a-zA-Z]/.test(n);
const initCounts = {};
const samples = {};

walk.simple(ast, {
  VariableDeclarator(node) {
    const v = node.id && node.id.name;
    if (!v || !isMinified(v) || namedVars.has(v)) return;
    const t = !node.init ? 'null' : node.init.type;
    let key = t;
    if (t === 'CallExpression') {
      let cn = '?';
      if (node.init.callee && node.init.callee.name) cn = node.init.callee.name;
      else if (node.init.callee && node.init.callee.type === 'MemberExpression') cn = 'mem';
      key = 'Call:' + cn;
    }
    initCounts[key] = (initCounts[key]||0)+1;
    if (!samples[key] && node.init) {
      const chunk = src.slice(node.init.start, Math.min(node.init.start+70, node.init.end)).replace(/\n/g,' ');
      samples[key] = v + ' = ' + chunk;
    }
  }
});

const sorted = Object.entries(initCounts).sort((a,b)=>b[1]-a[1]).slice(0,25);
for (const [k,c] of sorted) {
  const s = samples[k] ? ('  eg: '+samples[k]) : '';
  console.log(k.padEnd(28), c, s.slice(0,100));
}
