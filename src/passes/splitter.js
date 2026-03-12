/**
 * js-recover — Splitter pass
 * Detects bundler format and extracts modules from the bundle.
 */

const PATTERNS = {
  webpack4:      /\/\*+\s*\d+\s*\*+\//,
  webpack5:      /(?:__webpack_require__|__webpack_exports__|__webpack_modules__)/,
  rollup:        /\/\* rollup \|/i,
  esbuild:       /\/\/ node_modules\//,
  copilot:       /var\s+\w+\s*=\s*\w+\s*\(\s*\(\s*\)\s*=>/,
  commonjs:      /Object\.defineProperty\(exports,\s*['"]__esModule['"]/,
};

/**
 * Detect bundler format.
 * @param {string} source
 * @returns {string} Format name
 */
export function detectFormat(source) {
  if (PATTERNS.webpack5.test(source)) return 'webpack5';
  if (PATTERNS.webpack4.test(source)) return 'webpack4';
  if (PATTERNS.rollup.test(source))   return 'rollup';
  if (PATTERNS.esbuild.test(source))  return 'esbuild';
  if (PATTERNS.copilot.test(source))  return 'copilot';
  if (PATTERNS.commonjs.test(source)) return 'commonjs';
  return 'unknown';
}

/**
 * Extract modules from a copilot-style bundle.
 * Format: var X = R(() => { ... })
 */
function splitCopilot(source) {
  const mods = [];
  const re   = /var\s+(\w+)\s*=\s*\w+\s*\(\s*\(\s*\)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index;
    const name  = m[1];
    let depth = 0, pos = m.index + m[0].length - 1;
    while (pos < source.length) {
      if (source[pos] === '{') depth++;
      else if (source[pos] === '}') {
        depth--;
        if (depth === 0) {
          mods.push({ name, code: source.slice(start, pos + 2) }); // +2 for `);`
          break;
        }
      }
      pos++;
    }
  }
  return mods;
}

/**
 * Extract modules from a webpack4 bundle (comment-delimited chunks).
 */
function splitWebpack4(source) {
  const chunks  = source.split(/\/\*+\s*\d+\s*\*+\//);
  return chunks.filter(c => c.trim()).map((code, i) => ({ name: `module_${i}`, code }));
}

/**
 * Extract modules from an esbuild bundle (// node_modules/ comments).
 */
function splitEsbuild(source) {
  const parts = source.split(/(?=\/\/ node_modules\/)/);
  return parts.filter(c => c.trim()).map((code, i) => {
    const match = code.match(/\/\/ node_modules\/([^\n]+)/);
    const name  = match ? match[1].replace(/\//g, '_').replace(/[^a-zA-Z0-9_.]/g, '') : `chunk_${i}`;
    return { name, code };
  });
}

/**
 * Dispatch to format-specific splitter.
 * @param {string} source
 * @param {string} format
 * @returns {{ name: string, code: string }[]}
 */
export function extractModules(source, format) {
  switch (format) {
    case 'copilot':   return splitCopilot(source);
    case 'webpack4':  return splitWebpack4(source);
    case 'esbuild':   return splitEsbuild(source);
    default:          return [];
  }
}

/**
 * Full split pass — detect format then extract modules to outputDir.
 */
export async function split(source, outputDir) {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  const format = detectFormat(source);
  const mods   = extractModules(source, format);

  if (mods.length > 0) {
    mkdirSync(outputDir, { recursive: true });
    for (const mod of mods) {
      writeFileSync(join(outputDir, `${mod.name}.js`), mod.code);
    }
  }

  return { count: mods.length, format };
}

// ── Standalone runner ────────────────────────────────────────────────────────
export async function runSplit(inputPath, opts = {}) {
  const { readFileSync } = await import('fs');
  const { stripShebang } = await import('../utils/source.js');
  const ora   = (await import('ora')).default;
  const chalk = (await import('chalk')).default;

  const source  = stripShebang(readFileSync(inputPath, 'utf8'));
  const outDir  = opts.output ?? './modules';
  const sp      = ora('Detecting bundle format...').start();

  const { count, format } = await split(source, outDir);
  sp.succeed(chalk.green(`${format}: extracted ${count} modules → ${outDir}`));
}
