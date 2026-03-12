/**
 * js-recover — Test runner
 * node:test (Node ≥18). No external framework.
 */
import { test }    from 'node:test';
import assert      from 'node:assert/strict';
import { readFileSync } from 'fs';

import { stripShebang, lineCount }           from '../src/utils/source.js';
import { beautify }                           from '../src/passes/beautify.js';
import { buildRenameMap, applyRenameMap }     from '../src/passes/renamer.js';
import { detectFormat, extractModules }       from '../src/passes/splitter.js';
import { extractSymbols }                     from '../src/passes/indexer.js';

const FX = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// ── Utils ──────────────────────────────────────────────────────────────────
test('stripShebang — removes shebang', () => {
  assert.equal(stripShebang('#!/usr/bin/env node\nconst x = 1;'), 'const x = 1;');
});
test('stripShebang — no-op when no shebang', () => {
  const s = 'const x = 1;'; assert.equal(stripShebang(s), s);
});
test('lineCount — counts correctly', () => {
  assert.equal(lineCount('a\nb\nc'), 3);
  assert.equal(lineCount(''), 1);
});

// ── Beautify ───────────────────────────────────────────────────────────────
test('beautify — expands minified code', async () => {
  const out = await beautify('function foo(){return 1;}var x=foo();');
  assert.ok(out.split('\n').length > 1, 'should have multiple lines');
});
test('beautify — preserves escaped strings', async () => {
  const out = await beautify('var s="hello\\nworld";');
  assert.ok(out.includes('"hello\\nworld"'), 'must not unescape \\n');
});

// ── Renamer phase 1 (init-based) ───────────────────────────────────────────
test('renamer — p1: slash commands', async () => {
  const { map } = await buildRenameMap(`var ab="/init"; var cd="/help";`);
  assert.equal(map['ab'], 'CMD_INIT');
  assert.equal(map['cd'], 'CMD_HELP');
});
test('renamer — p1: new Map()', async () => {
  const { map } = await buildRenameMap(`var ab=new Map();`);
  assert.ok(map['ab'] && /map|registry/i.test(map['ab']), `expected map name, got ${map['ab']}`);
});
test('renamer — p1: new Set()', async () => {
  const { map } = await buildRenameMap(`var ab=new Set();`);
  assert.ok(map['ab'] && /set|pool/i.test(map['ab']), `expected set name, got ${map['ab']}`);
});
test('renamer — p1: require()', async () => {
  const { map } = await buildRenameMap(`var ab=require('chalk');`);
  assert.equal(map['ab'], 'mod_chalk');
});
test('renamer — p1: array literal', async () => {
  const { map } = await buildRenameMap(`var ab=[];`);
  assert.ok(map['ab'] && /arr|items|list/i.test(map['ab']), `expected array name, got ${map['ab']}`);
});
test('renamer — p1: object with named key', async () => {
  const { map } = await buildRenameMap(`var ab={session:1,auth:2};`);
  assert.ok(map['ab'] && /obj_/.test(map['ab']), `expected obj_ prefix, got ${map['ab']}`);
});

// ── Renamer phase 2 (usage-based) ─────────────────────────────────────────
test('renamer — p2: infers array from .push/.pop/.sort', async () => {
  const { map } = await buildRenameMap(`var ab=[]; ab.push(1); ab.push(2); ab.pop(); ab.sort();`);
  assert.ok(map['ab'] && /arr|list/i.test(map['ab']), `expected array name, got ${map['ab']}`);
});
test('renamer — p2: infers promise from .then/.catch/.finally', async () => {
  const { map } = await buildRenameMap(`var px=x(); px.then(r=>r).catch(e=>e).finally(()=>{});`);
  assert.ok(map['px'] && /promise/i.test(map['px']), `expected promise, got ${map['px']}`);
});
test('renamer — p2: infers string from .trim/.split/.toUpperCase', async () => {
  const { map } = await buildRenameMap(`var sv=x(); sv.trim(); sv.split(","); sv.toUpperCase();`);
  assert.ok(map['sv'] && /str/i.test(map['sv']), `expected str, got ${map['sv']}`);
});
test('renamer — p2: infers emitter from .on/.emit/.once', async () => {
  const { map } = await buildRenameMap(`var ev=x(); ev.on("d",cb); ev.emit("e"); ev.once("c",cb);`);
  assert.ok(map['ev'] && /emitter/i.test(map['ev']), `expected emitter, got ${map['ev']}`);
});

// ── Renamer guards ─────────────────────────────────────────────────────────
test('renamer — skips long names', async () => {
  const { map } = await buildRenameMap(`var myLongVariableName="/init";`);
  assert.ok(!map['myLongVariableName'], 'long names must not be renamed');
});
test('renamer — applyRenameMap whole-word only', () => {
  const out = applyRenameMap('var ab = 1; var abcd = 2;', { ab: 'CMD_INIT' });
  assert.ok(out.includes('CMD_INIT'), 'should replace ab');
  assert.ok(out.includes('abcd'),     'should NOT replace abcd');
});
test('renamer — no renames on readable source', async () => {
  const { map } = await buildRenameMap('var helloWorld = 1; var longName = 2;');
  assert.equal(Object.keys(map).length, 0);
});
test('renamer — stats object present', async () => {
  const result = await buildRenameMap(`var ab="/init";`);
  assert.ok(result.stats, 'stats should exist');
  assert.ok(typeof result.stats.total === 'number', 'stats.total should be number');
  assert.ok(typeof result.stats.static === 'number', 'stats.static should be number');
  assert.ok(typeof result.stats.llm === 'number', 'stats.llm should be number');
});

// ── Splitter ───────────────────────────────────────────────────────────────
test('splitter — detects webpack4',  () => assert.equal(detectFormat(FX('webpack4.js')), 'webpack4'));
test('splitter — detects esbuild',   () => assert.equal(detectFormat(FX('esbuild.js')),  'esbuild'));
test('splitter — detects copilot',   () => assert.equal(detectFormat(FX('copilot.js')),  'copilot'));
test('splitter — extracts copilot modules', () => {
  const mods = extractModules(FX('copilot.js'), 'copilot');
  assert.ok(mods.length >= 2, 'should extract ≥2 modules');
  assert.ok(mods.every(m => m.name && m.code), 'each module has name + code');
});
test('splitter — extracts esbuild chunks', () => {
  const mods = extractModules(FX('esbuild.js'), 'esbuild');
  assert.ok(mods.length >= 2, 'should extract ≥2 chunks');
});
test('splitter — unknown returns empty', () => {
  assert.deepEqual(extractModules('console.log(1);', 'unknown'), []);
});

// ── Indexer ────────────────────────────────────────────────────────────────
test('indexer — finds functions, classes, variables', () => {
  const names = extractSymbols(FX('simple.js')).map(s => s.name);
  assert.ok(names.includes('fn1'), 'fn1 found');
  assert.ok(names.includes('fn2'), 'fn2 found');
  assert.ok(names.includes('Foo'), 'Foo found');
});
test('indexer — all symbols have line numbers', () => {
  const syms = extractSymbols(FX('simple.js'));
  assert.ok(syms.length > 0);
  assert.ok(syms.every(s => typeof s.line === 'number' && s.line > 0));
});
test('indexer — reports kinds', () => {
  const kinds = new Set(extractSymbols(FX('simple.js')).map(s => s.kind));
  assert.ok(kinds.has('function') || kinds.has('class'));
});
