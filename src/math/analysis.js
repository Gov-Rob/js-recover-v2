/**
 * js-recover — Mathematical pattern analysis engine
 *
 * Terser/UglifyJS follow deterministic algorithms:
 *   1. Variables are renamed in order of decreasing usage frequency
 *      (most-used → shortest name: a, b, c ... z, a0 ... zz ...)
 *   2. Each scope gets its own namespace — inner scopes reuse outer names
 *   3. Character set is: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_0123456789
 *
 * This module implements:
 *   - Terser name sequence generation (predict mangled→rank mapping)
 *   - Frequency analysis (usage count → importance score)
 *   - Shannon entropy (identify minified vs readable identifiers)
 *   - N-gram co-occurrence (cluster variables that travel together → same module)
 *   - Positional scoring (early declarations = core utilities)
 */

// ── Terser Name Sequence ──────────────────────────────────────────────────────

const TERSER_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_';
const TERSER_CONT  = TERSER_CHARS + '0123456789';

/**
 * Generate the Nth name in Terser's mangling sequence.
 * Sequence: a,b,...,z,A,...,Z,$,_,a0,b0,...,_9,aa,ba,...
 * @param {number} n  Zero-based rank
 * @returns {string}
 */
export function terserName(n) {
  let name = TERSER_CHARS[n % TERSER_CHARS.length];
  n = Math.floor(n / TERSER_CHARS.length);
  while (n > 0) {
    n--;
    name += TERSER_CONT[n % TERSER_CONT.length];
    n = Math.floor(n / TERSER_CONT.length);
  }
  return name;
}

/**
 * Build the inverse: name → rank (for all names up to maxRank).
 * @param {number} [maxRank=5000]
 * @returns {Map<string, number>}
 */
export function buildTerserIndex(maxRank = 5000) {
  const index = new Map();
  for (let i = 0; i < maxRank; i++) {
    index.set(terserName(i), i);
  }
  return index;
}

// ── Shannon Entropy ───────────────────────────────────────────────────────────

/**
 * Compute Shannon entropy of a string.
 * High entropy → looks random → likely minified.
 * Low entropy → repetitive chars → likely readable (camelCase has patterns).
 * @param {string} s
 * @returns {number}  bits per character
 */
export function shannonEntropy(s) {
  if (s.length === 0) return 0;
  const freq = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  let H = 0;
  for (const f of Object.values(freq)) {
    const p = f / s.length;
    H -= p * Math.log2(p);
  }
  return H;
}

/**
 * Score how "minified" an identifier looks (0 = clearly readable, 1 = clearly minified).
 * Uses: length, entropy, character case mixing, vowel ratio.
 * @param {string} name
 * @returns {number}
 */
export function minificationScore(name) {
  if (name.length > 8) return 0;          // long names are never minified
  if (name.length === 1) return 0.9;      // single char is almost certainly minified

  const H          = shannonEntropy(name);
  const lengthScore = Math.max(0, 1 - (name.length - 1) / 6);  // shorter = more minified
  const entropyScore = Math.min(1, H / 4);                      // high entropy = minified
  const vowels     = (name.match(/[aeiou]/gi) ?? []).length / name.length;
  const vowelScore = vowels < 0.2 ? 0.7 : vowels > 0.4 ? 0.3 : 0.5;  // few vowels → minified

  return (lengthScore * 0.4 + entropyScore * 0.35 + vowelScore * 0.25);
}

// ── Frequency Analysis ────────────────────────────────────────────────────────

/**
 * Count all Identifier node occurrences in one walk.
 * @param {object} ast
 * @param {object} walk  acorn-walk module
 * @returns {Map<string, number>}
 */
export function buildFrequencyMap(ast, walk) {
  const freq = new Map();
  walk.simple(ast, {
    Identifier(node) {
      freq.set(node.name, (freq.get(node.name) ?? 0) + 1);
    },
  });
  return freq;
}

/**
 * Given a frequency map, rank identifiers by usage count.
 * Filter to only minified-looking names.
 * Returns { name → { rank, count, terserRank, likelyImportance } }
 * @param {Map<string,number>} freqMap
 * @param {Map<string,number>} terserIndex  from buildTerserIndex()
 * @returns {Map<string, object>}
 */
export function rankIdentifiers(freqMap, terserIndex) {
  // Sort by frequency descending
  const sorted = [...freqMap.entries()]
    .filter(([name]) => minificationScore(name) > 0.4)
    .sort((a, b) => b[1] - a[1]);

  const result = new Map();
  sorted.forEach(([name, count], rank) => {
    const terserRank = terserIndex.get(name);
    result.set(name, {
      rank,          // rank by frequency in this bundle
      count,         // total occurrences
      terserRank,    // rank in Terser's sequence (if it matches)
      // If terserRank ≈ rank → high confidence it was minified in frequency order
      rankMatch: terserRank !== undefined && Math.abs(terserRank - rank) < 20,
      // Importance: higher frequency = was more important in original
      importance: count > 100 ? 'critical' : count > 20 ? 'high' : count > 5 ? 'medium' : 'low',
    });
  });
  return result;
}

// ── N-gram Co-occurrence ──────────────────────────────────────────────────────

/**
 * Build a co-occurrence matrix: which pairs of minified identifiers
 * appear within N tokens of each other.
 * Variables that co-occur frequently are likely from the same module/closure.
 * @param {object} ast
 * @param {object} walk
 * @param {Set<string>} minifiedNames  names to track
 * @param {number} [windowSize=10]
 * @returns {Map<string, Map<string, number>>}  name → {coName → count}
 */
export function buildCooccurrence(ast, walk, minifiedNames, windowSize = 10) {
  // Collect all identifier occurrences in source order
  const occurrences = [];
  walk.simple(ast, {
    Identifier(node) {
      if (minifiedNames.has(node.name)) {
        occurrences.push({ name: node.name, pos: node.start });
      }
    },
  });
  occurrences.sort((a, b) => a.pos - b.pos);

  const matrix = new Map();
  function ensure(n) { if (!matrix.has(n)) matrix.set(n, new Map()); return matrix.get(n); }

  for (let i = 0; i < occurrences.length; i++) {
    const a = occurrences[i].name;
    for (let j = i + 1; j < Math.min(i + windowSize, occurrences.length); j++) {
      const b = occurrences[j].name;
      if (a === b) continue;
      const ma = ensure(a); ma.set(b, (ma.get(b) ?? 0) + 1);
      const mb = ensure(b); mb.set(a, (mb.get(a) ?? 0) + 1);
    }
  }
  return matrix;
}

/**
 * Cluster minified names into groups by co-occurrence similarity.
 * Variables in the same cluster likely belong to the same original module.
 * Uses simple greedy threshold clustering.
 * @param {Map<string, Map<string,number>>} coMatrix
 * @param {number} [threshold=5]  min co-occurrences to be "same cluster"
 * @returns {string[][]}  array of clusters (each is an array of names)
 */
export function clusterByCooccurrence(coMatrix, threshold = 5) {
  const assigned = new Map();
  const clusters = [];
  let clusterId  = 0;

  for (const [name, coNames] of coMatrix) {
    if (assigned.has(name)) continue;

    const cluster = [name];
    assigned.set(name, clusterId);

    for (const [coName, count] of coNames) {
      if (count >= threshold && !assigned.has(coName)) {
        cluster.push(coName);
        assigned.set(coName, clusterId);
      }
    }

    if (cluster.length > 1) clusters.push(cluster);
    clusterId++;
  }

  return clusters;
}

// ── Positional scoring ────────────────────────────────────────────────────────

/**
 * Score variables by their declaration position in the file.
 * Variables declared near the top of a bundle are usually the most important
 * (core utilities, module registry, etc.).
 * @param {object} ast
 * @param {object} walk
 * @param {number} totalLength  source.length
 * @returns {Map<string, number>}  name → positional score (0–1, higher = earlier)
 */
export function buildPositionalScores(ast, walk, totalLength) {
  const firstSeen = new Map();
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier' && !firstSeen.has(node.id.name)) {
        firstSeen.set(node.id.name, node.start);
      }
    },
  });

  const scores = new Map();
  for (const [name, pos] of firstSeen) {
    scores.set(name, 1 - pos / totalLength);
  }
  return scores;
}
