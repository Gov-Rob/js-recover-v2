/**
 * js-recover — Indexer pass
 * Builds a searchable symbol index of all named identifiers in a JS file.
 */
import * as acorn from 'acorn';
import * as walk  from 'acorn-walk';

const PARSE_OPTS = {
  ecmaVersion:                  'latest',
  sourceType:                   'module',
  allowHashBang:                true,
  allowImportExportEverywhere:  true,
  locations:                    true,   // we need line numbers
};

/**
 * Extract all named symbols from source.
 * @param {string} source
 * @returns {{ kind: string, name: string, line: number }[]}
 */
export function extractSymbols(source) {
  let ast;
  try {
    ast = acorn.parse(source, PARSE_OPTS);
  } catch (e) {
    try {
      ast = acorn.parse(source, { ...PARSE_OPTS, sourceType: 'script' });
    } catch {
      throw new Error(`AST parse failed: ${e.message}`);
    }
  }

  const symbols = [];

  walk.simple(ast, {
    FunctionDeclaration(node) {
      if (node.id) symbols.push({ kind: 'function', name: node.id.name, line: node.loc.start.line });
    },
    FunctionExpression(node) {
      if (node.id) symbols.push({ kind: 'function', name: node.id.name, line: node.loc.start.line });
    },
    ArrowFunctionExpression(node) {
      // Arrow functions rarely have names but we catch assigned ones via VariableDeclarator
    },
    ClassDeclaration(node) {
      if (node.id) symbols.push({ kind: 'class', name: node.id.name, line: node.loc.start.line });
    },
    ClassExpression(node) {
      if (node.id) symbols.push({ kind: 'class', name: node.id.name, line: node.loc.start.line });
    },
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier') {
        const kind = node.init?.type === 'ArrowFunctionExpression' ||
                     node.init?.type === 'FunctionExpression' ? 'function' : 'variable';
        symbols.push({ kind, name: node.id.name, line: node.loc.start.line });
      }
    },
    ExportNamedDeclaration(node) {
      if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.id) {
        symbols.push({ kind: 'export:function', name: node.declaration.id.name, line: node.loc.start.line });
      }
    },
    ExportDefaultDeclaration(node) {
      if (node.declaration?.id) {
        symbols.push({ kind: 'export:default', name: node.declaration.id.name, line: node.loc.start.line });
      }
    },
    MethodDefinition(node) {
      if (node.key?.type === 'Identifier') {
        symbols.push({ kind: `method:${node.kind}`, name: node.key.name, line: node.loc.start.line });
      }
    },
    Property(node) {
      if (node.key?.type === 'Identifier' &&
          (node.value?.type === 'FunctionExpression' || node.value?.type === 'ArrowFunctionExpression')) {
        symbols.push({ kind: 'method:property', name: node.key.name, line: node.loc.start.line });
      }
    },
  });

  return symbols;
}

/**
 * Build markdown reference table from symbols.
 */
function toMarkdown(symbols, title) {
  const lines = [
    `# ${title} — Symbol Reference`,
    `> ${symbols.length.toLocaleString()} symbols found\n`,
    '| Kind | Name | Line |',
    '|------|------|------|',
  ];
  for (const s of symbols) {
    lines.push(`| ${s.kind} | \`${s.name}\` | ${s.line} |`);
  }
  return lines.join('\n');
}

/**
 * Full index pass.
 */
export async function buildIndex(source, outputDir, name) {
  const { writeFileSync } = await import('fs');
  const { join } = await import('path');

  const symbols = extractSymbols(source);

  writeFileSync(
    join(outputDir, `${name}.symbols.json`),
    JSON.stringify({ total: symbols.length, symbols }, null, 2)
  );
  writeFileSync(
    join(outputDir, `${name}.SYMBOLS.md`),
    toMarkdown(symbols, name)
  );

  return { count: symbols.length };
}

// ── Standalone runner ────────────────────────────────────────────────────────
export async function runIndex(inputPath, opts = {}) {
  const { readFileSync } = await import('fs');
  const { basename, extname } = await import('path');
  const { stripShebang } = await import('../utils/source.js');
  const ora   = (await import('ora')).default;
  const chalk = (await import('chalk')).default;

  const source = stripShebang(readFileSync(inputPath, 'utf8'));
  const name   = basename(inputPath, extname(inputPath));
  const outDir = opts.output ?? '.';
  const sp     = ora('Indexing symbols...').start();

  const { count } = await buildIndex(source, outDir, name);
  sp.succeed(chalk.green(`${count.toLocaleString()} symbols indexed → ${outDir}/${name}.symbols.json`));
}
