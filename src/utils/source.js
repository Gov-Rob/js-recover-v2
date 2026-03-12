/**
 * js-recover — Source utilities
 */

/**
 * Remove shebang line if present.
 * @param {string} source
 * @returns {string}
 */
export function stripShebang(source) {
  return source.startsWith('#!') ? source.replace(/^#![^\n]*\n/, '') : source;
}

/**
 * Count lines in a string.
 * @param {string} s
 * @returns {number}
 */
export function lineCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') n++;
  }
  return n + 1;
}
