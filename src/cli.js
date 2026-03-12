/**
 * js-recover — CLI definition
 * Separates command parsing from entry point so tests can import directly.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dir, '../package.json'), 'utf8'));

export function createCommand() {
  const program = new Command();

  program
    .name('js-recover')
    .description(
      chalk.cyan('js-recover') + ' — Enterprise JS Source Recovery Tool\n' +
      'Deobfuscate, split, rename and index minified JavaScript bundles.'
    )
    .version(pkg.version);

  /* ── recover (default) ─────────────────────────────────────────────── */
  program
    .command('recover <input>', { isDefault: true })
    .description('Run full multi-pass recovery pipeline on a minified JS file')
    .option('-o, --output <dir>',   'Output directory',   './recovered')
    .option('--seeds <file>',       'JSON file of {mangled: semantic} seed mappings for this bundle')
    .option('--no-beautify',        'Skip beautification pass')
    .option('--no-rename',          'Skip AST variable renaming')
    .option('--no-split',           'Skip bundle module splitting')
    .option('--no-index',           'Skip symbol index generation')
    .option('--indent <n>',         'Indentation spaces', '2')
    .option('--verbose',            'Verbose output')
    .action(async (input, opts) => {
      const { runPipeline } = await import('./pipeline.js');
      await runPipeline(resolve(input), opts);
    });

  /* ── beautify ──────────────────────────────────────────────────────── */
  program
    .command('beautify <input>')
    .description('Format a minified JS file (beautify pass only)')
    .option('-o, --output <file>',  'Output file (default: <input>.pretty.js)')
    .option('--indent <n>',         'Indentation spaces', '2')
    .action(async (input, opts) => {
      const { runBeautify } = await import('./passes/beautify.js');
      await runBeautify(resolve(input), opts);
    });

  /* ── rename ────────────────────────────────────────────────────────── */
  program
    .command('rename <input>')
    .description('AST-based semantic variable renaming only')
    .option('-o, --output <file>',       'Output file')
    .option('--map <file>',              'Save rename map to JSON file')
    .option('--seeds <file>',            'JSON file of {mangled: semantic} seed mappings for this bundle')
    .option('--llm',                     'Enable GitHub Copilot LLM naming pass (requires GH_TOKEN)')
    .option('--llm-max <n>',             'Max uncertain vars to send to LLM', '300')
    .option('--llm-batch <n>',           'LLM batch size per API call', '15')
    .option('--no-workers',              'Disable worker thread math analysis')
    .option('--graph',                   'Enable HelixHyper graph pipeline (community detection + propagation)')
    .option('--graph-seeds <n>',         'LLM seeds per cluster in graph pass', '3')
    .action(async (input, opts) => {
      const { runRename } = await import('./passes/renamer.js');
      await runRename(resolve(input), {
        ...opts,
        llm:         opts.llm ?? !!process.env.GH_TOKEN,
        llmMaxVars:  parseInt(opts.llmMax ?? '300', 10),
        llmBatchSize:parseInt(opts.llmBatch ?? '15', 10),
        workers:     opts.workers !== false,
        graph:       opts.graph ?? false,
        graphSeeds:  parseInt(opts.graphSeeds ?? '3', 10),
        seedsFile:   opts.seeds ?? null,
      });
    });

  /* ── split ─────────────────────────────────────────────────────────── */
  program
    .command('split <input>')
    .description('Detect and split a webpack/rollup/esbuild/copilot bundle into modules')
    .option('-o, --output <dir>',   'Output directory', './modules')
    .action(async (input, opts) => {
      const { runSplit } = await import('./passes/splitter.js');
      await runSplit(resolve(input), opts);
    });

  /* ── index ─────────────────────────────────────────────────────────── */
  program
    .command('index <input>')
    .description('Generate searchable symbol index (functions, classes, variables, exports)')
    .option('-o, --output <dir>',   'Output directory', '.')
    .option('--json',               'Emit JSON index (default: true)')
    .option('--md',                 'Also emit Markdown reference table')
    .action(async (input, opts) => {
      const { runIndex } = await import('./passes/indexer.js');
      await runIndex(resolve(input), opts);
    });

  return program;
}
