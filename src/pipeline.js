/**
 * js-recover — Pipeline orchestrator
 * Runs all passes in sequence, wiring stripped source through each stage.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';
import chalk from 'chalk';
import ora from 'ora';

import { beautify }     from './passes/beautify.js';
import { rename }       from './passes/renamer.js';
import { split }        from './passes/splitter.js';
import { buildIndex }   from './passes/indexer.js';
import { stripShebang } from './utils/source.js';

export async function runPipeline(inputPath, opts = {}) {
  const {
    output    = './recovered',
    beautify: doBeautify = true,
    rename:   doRename   = true,
    split:    doSplit    = true,
    index:    doIndex    = true,
    indent    = '2',
    verbose   = false,
    seeds     = null,    // preloaded seeds dict
    seedsFile = null,    // path to seeds JSON file
  } = opts;

  mkdirSync(output, { recursive: true });

  const name   = basename(inputPath, extname(inputPath));
  const raw    = readFileSync(inputPath, 'utf8');
  const source = stripShebang(raw);

  printHeader(inputPath, output);

  const report = {
    input: inputPath,
    output,
    tool: 'js-recover',
    version: '1.0.0',
    startedAt: new Date().toISOString(),
    passes: [],
    stats: {},
  };

  // ── PASS 1: Beautify ────────────────────────────────────────────────────
  let pretty = source;
  if (doBeautify) {
    const sp = spinner('Beautifying...');
    try {
      pretty = await beautify(source, parseInt(indent));
      const out = join(output, `${name}.pretty.js`);
      writeFileSync(out, pretty);
      sp.succeed(chalk.green(`Beautified → ${out}`));
      report.passes.push('beautify');
      report.stats.lines = pretty.split('\n').length;
    } catch (e) {
      sp.fail(`Beautify: ${e.message}`);
      if (verbose) console.error(e.stack);
    }
  }

  // ── PASS 2: Rename ──────────────────────────────────────────────────────
  // Always run on original stripped source (AST-safe, no escaped strings)
  if (doRename) {
    const sp = spinner('Analysing AST — semantic variable renaming...');
    try {
      const { count, map, code: renamedRaw } = await rename(source, { seeds, seedsFile });
      if (count > 0) {
        // Apply same renames to the beautified output
        pretty = applyRenameMap(pretty, map);
        writeFileSync(join(output, `${name}.pretty.js`), pretty);          // overwrite with renames applied
        writeFileSync(join(output, `${name}.renamed.js`), renamedRaw);     // raw renamed (minified)
        writeFileSync(join(output, `${name}.rename-map.json`),
          JSON.stringify({ total: count, map }, null, 2));
        sp.succeed(chalk.green(`Renamed ${count} variables`));
        report.passes.push('rename');
        report.stats.renamed = count;
      } else {
        sp.warn('No confident renames found');
      }
    } catch (e) {
      sp.fail(`Rename: ${e.message}`);
      if (verbose) console.error(e.stack);
    }
  }

  // ── PASS 3: Split ───────────────────────────────────────────────────────
  if (doSplit) {
    const sp = spinner('Detecting bundler and splitting modules...');
    try {
      const modDir = join(output, 'modules');
      const { count: modCount, format } = await split(source, modDir);
      sp.succeed(chalk.green(`Split ${modCount} modules [${format}] → ${modDir}`));
      report.passes.push('split');
      report.stats.modules = modCount;
      report.stats.bundler = format;
    } catch (e) {
      sp.fail(`Split: ${e.message}`);
      if (verbose) console.error(e.stack);
    }
  }

  // ── PASS 4: Symbol Index ────────────────────────────────────────────────
  if (doIndex) {
    const sp = spinner('Building symbol index...');
    try {
      const { count: symCount } = await buildIndex(source, output, name);
      sp.succeed(chalk.green(`Indexed ${symCount.toLocaleString()} symbols`));
      report.passes.push('index');
      report.stats.symbols = symCount;
    } catch (e) {
      sp.fail(`Index: ${e.message}`);
      if (verbose) console.error(e.stack);
    }
  }

  // ── REPORT ──────────────────────────────────────────────────────────────
  report.completedAt = new Date().toISOString();
  report.durationMs  = Date.now() - new Date(report.startedAt).getTime();
  writeFileSync(join(output, 'recovery-report.json'), JSON.stringify(report, null, 2));

  printSummary(report);
  return report;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function printHeader(input, output) {
  console.log(chalk.cyan('\n  ╔══════════════════════════════════╗'));
  console.log(chalk.cyan('  ║  js-recover  v1.0.0              ║'));
  console.log(chalk.cyan('  ║  Enterprise JS Source Recovery    ║'));
  console.log(chalk.cyan('  ╚══════════════════════════════════╝\n'));
  console.log(chalk.gray(`  Input   ${input}`));
  console.log(chalk.gray(`  Output  ${output}\n`));
}

function printSummary(r) {
  const ms = r.durationMs;
  const elapsed = ms > 60000 ? `${(ms/60000).toFixed(1)}m` : `${(ms/1000).toFixed(1)}s`;
  console.log(chalk.cyan('\n  ── Complete ────────────────────────────'));
  if (r.stats.lines)   console.log(chalk.white(`  Lines    ${r.stats.lines.toLocaleString()}`));
  if (r.stats.renamed) console.log(chalk.white(`  Renamed  ${r.stats.renamed} variables`));
  if (r.stats.modules) console.log(chalk.white(`  Modules  ${r.stats.modules} extracted [${r.stats.bundler}]`));
  if (r.stats.symbols) console.log(chalk.white(`  Symbols  ${r.stats.symbols.toLocaleString()} indexed`));
  console.log(chalk.gray(`  Time     ${elapsed}`));
  console.log(chalk.green(`  Output → ${r.output}\n`));
}

function spinner(text) {
  return ora({ text, color: 'cyan' }).start();
}

function applyRenameMap(code, map) {
  // Single-pass tokenizer: split on identifier boundaries, replace in O(n)
  const ident = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let result = '';
  let last = 0;
  let m;
  while ((m = ident.exec(code)) !== null) {
    result += code.slice(last, m.index);
    result += map[m[0]] ?? m[0];
    last = ident.lastIndex;
  }
  result += code.slice(last);
  return result;
}
