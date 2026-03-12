/**
 * js-recover — Beautify pass
 */
import pkg from 'js-beautify';
const { js } = pkg;

const OPTS = {
  indent_size:              2,
  indent_char:              ' ',
  max_preserve_newlines:    1,
  preserve_newlines:        true,
  keep_array_indentation:   false,
  break_chained_methods:    true,
  brace_style:              'collapse,preserve-inline',
  space_before_conditional: true,
  unescape_strings:         false,   // keep \n as \n — required for valid AST later
  jslint_happy:             false,
  end_with_newline:         true,
  wrap_line_length:         0,
  comma_first:              false,
  indent_empty_lines:       false,
};

/**
 * Beautify source code.
 * @param {string} source - JS source (shebang already stripped)
 * @param {number} [indentSize=2]
 * @returns {Promise<string>}
 */
export async function beautify(source, indentSize = 2) {
  return js(source, { ...OPTS, indent_size: indentSize });
}

// ── Standalone runner ────────────────────────────────────────────────────────
export async function runBeautify(inputPath, opts = {}) {
  const { readFileSync, writeFileSync } = await import('fs');
  const { join, basename, extname, dirname } = await import('path');
  const { stripShebang } = await import('../utils/source.js');
  const ora = (await import('ora')).default;
  const chalk = (await import('chalk')).default;

  const src  = stripShebang(readFileSync(inputPath, 'utf8'));
  const sp   = ora('Beautifying...').start();
  const out  = await beautify(src, parseInt(opts.indent || '2'));
  const dest = opts.output ?? join(
    dirname(inputPath),
    `${basename(inputPath, extname(inputPath))}.pretty.js`
  );
  writeFileSync(dest, out);
  sp.succeed(chalk.green(`→ ${dest}  (${out.split('\n').length.toLocaleString()} lines)`));
}
