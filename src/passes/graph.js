/**
 * js-recover — Native Graph Pipeline (Phase 5)
 *
 * Replaces HelixHyper MCP dependencies with native JS implementations.
 * All graph operations (PageRank, community detection, influence propagation)
 * run in-process — no external services required.
 *
 *  Step 1 — ANALYZE:   Build co-occurrence / scope edge graph from AST.
 *  Step 2 — RANK:      Native PageRank identifies central uncertain vars.
 *  Step 3 — CLUSTER:   Label propagation groups vars into semantic communities.
 *  Step 4 — SEED:      Top-N uncertain vars per cluster sent to Copilot LLM.
 *  Step 5 — PROPAGATE: Independent Cascade spreads names through cluster edges.
 *  Step 6 — MERGE:     Results merged back into caller's rename map.
 */

import * as acorn from 'acorn';
import * as walk  from 'acorn-walk';

// ── Config ────────────────────────────────────────────────────────────────────

const PARSE_OPTS = {
  ecmaVersion:                 'latest',
  sourceType:                  'module',
  allowHashBang:               true,
  allowImportExportEverywhere: true,
  locations:                   false,
};

const SEEDS_PER_CLUSTER = 3;
const MIN_EDGE_WEIGHT   = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMinified(name) {
  if (!name || name.length > 7) return false;
  if (['i','j','k','n','s','e','t','r','x','y','ok','id','fn','cb','el',
       'ms','db','fs','vm','io','os'].includes(name)) return false;
  return /^[a-zA-Z$_][a-zA-Z0-9$_]{0,6}$/.test(name);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractContext(source, varName, lines = 8) {
  const idx = source.indexOf(varName);
  if (idx === -1) return '';
  const start = Math.max(0, source.lastIndexOf('\n', idx - 1) + 1);
  let end = idx, count = 0;
  while (end < source.length && count < lines) {
    if (source[end] === '\n') count++;
    end++;
  }
  return source.slice(start, end).trim().slice(0, 600);
}

// ── Step 1: Build co-occurrence + scope graph from AST ────────────────────────

/**
 * Analyze the AST of a minified source file.
 * Returns:
 *   edges:  Map<varA, Map<varB, weight>>  (undirected, canonical order)
 *   freq:   Map<varName, count>           (usage frequency)
 *   scopes: Map<scopeId, Set<varName>>    (vars declared in same function body)
 */
export function analyzeRelationships(source) {
  let ast;
  try {
    ast = acorn.parse(source, PARSE_OPTS);
  } catch {
    ast = acorn.parse(source, { ...PARSE_OPTS, sourceType: 'script' });
  }

  const edges  = new Map();
  const freq   = new Map();
  const scopes = new Map();
  let scopeCounter = 0;

  function addEdge(a, b, w = 1) {
    if (a === b || !a || !b) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!edges.has(lo)) edges.set(lo, new Map());
    const nbrs = edges.get(lo);
    nbrs.set(hi, (nbrs.get(hi) ?? 0) + w);
  }

  function incFreq(name) {
    if (!isMinified(name)) return;
    freq.set(name, (freq.get(name) ?? 0) + 1);
  }

  const scopeStack = [];

  function enterScope() {
    const id = `scope_${scopeCounter++}`;
    const vars = new Set();
    scopes.set(id, vars);
    scopeStack.push({ id, vars });
  }

  function leaveScope() { scopeStack.pop(); }

  function declareInScope(name) {
    if (!isMinified(name)) return;
    const frame = scopeStack[scopeStack.length - 1];
    if (frame) frame.vars.add(name);
  }

  walk.full(ast, (node) => {
    if (node.type === 'Identifier' && isMinified(node.name)) {
      incFreq(node.name);
    }

    if (node.type === 'CallExpression') {
      const minArgs = (node.arguments ?? [])
        .filter(a => a.type === 'Identifier' && isMinified(a.name))
        .map(a => a.name);
      for (let i = 0; i < minArgs.length; i++)
        for (let j = i + 1; j < minArgs.length; j++)
          addEdge(minArgs[i], minArgs[j], 2);
      const calleeName = node.callee?.name ?? node.callee?.property?.name;
      if (calleeName && isMinified(calleeName) && minArgs.length)
        addEdge(calleeName, minArgs[0], 3);
    }

    if (['BinaryExpression','LogicalExpression','AssignmentExpression'].includes(node.type)) {
      const l = node.left?.name, r = node.right?.name;
      if (l && r && isMinified(l) && isMinified(r)) addEdge(l, r, 1);
    }

    if (node.type === 'ConditionalExpression') {
      const t = node.test?.name, c = node.consequent?.name, a = node.alternate?.name;
      if (t && c && isMinified(t) && isMinified(c)) addEdge(t, c, 1);
      if (t && a && isMinified(t) && isMinified(a)) addEdge(t, a, 1);
    }

    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const lhs = node.id.name;
      if (isMinified(lhs) && node.init?.type === 'CallExpression') {
        declareInScope(lhs);
        const callArgs = (node.init.arguments ?? [])
          .filter(a => a.type === 'Identifier' && isMinified(a.name))
          .map(a => a.name);
        for (const arg of callArgs) addEdge(lhs, arg, 2);
      }
    }

    if (node.type === 'MemberExpression' &&
        node.object?.type === 'Identifier' && isMinified(node.object.name) &&
        node.property?.type === 'Identifier') {
      incFreq(node.object.name);
    }
  });

  // Scope siblings: weak edges between vars declared in the same function
  for (const [, vars] of scopes) {
    const arr = [...vars].filter(v => isMinified(v));
    if (arr.length < 2 || arr.length > 20) continue;
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length && j < i + 5; j++)
        addEdge(arr[i], arr[j], 1);
  }

  return { edges, freq, scopes };
}

// ── Native graph algorithms ───────────────────────────────────────────────────

/**
 * Power-iteration PageRank.
 * edges: Map<node, Map<neighbor, weight>>  (directed or undirected)
 * Returns Map<node, score>
 */
function nativePageRank(edges, iterations = 20, damping = 0.85) {
  const nodes = new Set([
    ...edges.keys(),
    ...[...edges.values()].flatMap(m => [...m.keys()]),
  ]);
  const n = nodes.size;
  if (n === 0) return new Map();

  const rank   = new Map([...nodes].map(v => [v, 1 / n]));
  const outSum = new Map([...nodes].map(v => {
    const nbrs  = edges.get(v);
    const total = nbrs ? [...nbrs.values()].reduce((a, b) => a + b, 0) : 0;
    return [v, total];
  }));

  for (let i = 0; i < iterations; i++) {
    const newRank = new Map([...nodes].map(v => [v, (1 - damping) / n]));
    for (const [from, nbrs] of edges) {
      const out = outSum.get(from) || 1;
      for (const [to, w] of nbrs) {
        newRank.set(to, (newRank.get(to) || 0) + damping * (rank.get(from) || 0) * (w / out));
      }
    }
    for (const [v, r] of newRank) rank.set(v, r);
  }
  return rank;
}

/**
 * Label Propagation community detection.
 * Returns Array<string[]> — sorted largest-first.
 */
function labelPropagation(edges, iterations = 10) {
  const nodes = new Set([
    ...edges.keys(),
    ...[...edges.values()].flatMap(m => [...m.keys()]),
  ]);
  const labels = new Map([...nodes].map((v, i) => [v, i]));

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (const v of [...nodes].sort(() => Math.random() - 0.5)) {
      const nbrs = edges.get(v);
      if (!nbrs || nbrs.size === 0) continue;
      const votes = new Map();
      for (const [nb, w] of nbrs) {
        const l = labels.get(nb);
        votes.set(l, (votes.get(l) || 0) + w);
      }
      const best = [...votes.entries()].reduce((a, b) => b[1] > a[1] ? b : a)[0];
      if (best !== labels.get(v)) { labels.set(v, best); changed = true; }
    }
    if (!changed) break;
  }

  const communities = new Map();
  for (const [v, l] of labels) {
    if (!communities.has(l)) communities.set(l, []);
    communities.get(l).push(v);
  }
  return [...communities.values()].sort((a, b) => b.length - a.length);
}

/**
 * Independent Cascade influence propagation.
 * seeds: string[]  — starting nodes
 * Returns Set<string> of all activated nodes (including seeds).
 */
function independentCascade(edges, seeds, probability = 0.4, steps = 5) {
  const activated = new Set(seeds);
  let frontier = [...seeds];
  for (let s = 0; s < steps && frontier.length > 0; s++) {
    const next = [];
    for (const node of frontier) {
      const nbrs = edges.get(node);
      if (!nbrs) continue;
      for (const [nb, weight] of nbrs) {
        if (!activated.has(nb) && Math.random() < probability * Math.min(weight / 3, 1)) {
          activated.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return activated;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the native graph pipeline on uncertain vars.
 *
 * @param {string}   source        — full minified JS source
 * @param {string[]} uncertainVars — vars not yet named by static passes
 * @param {object}   existingMap   — { varName: semanticName } from static passes
 * @param {object}   opts
 *   graph          {boolean}  — enable this pass at all (default: true)
 *   llm            {boolean}  — use Copilot LLM for seed naming
 *   seedsPerCluster {number}  — LLM seeds per community (default: 3)
 *   llmBatchSize   {number}   — batch size for LLM calls (default: 10)
 *
 * @returns {{ map: object, stats: object }}
 */
export async function graphPass(source, uncertainVars, existingMap = {}, opts = {}) {
  const {
    graph           = true,
    llm             = !!process.env.GH_TOKEN,
    seedsPerCluster = SEEDS_PER_CLUSTER,
    llmBatchSize    = 10,
  } = opts;

  if (!graph) return { map: {}, stats: { skipped: true } };

  const result = {};

  try {
    // Step 1: build edge graph from AST
    console.error('[graph] analyzing variable relationships...');
    const { edges, freq } = analyzeRelationships(source);

    // Step 2: filter edges to uncertain vars only
    const uncertainSet = new Set(uncertainVars);
    const filteredEdges = new Map();
    for (const [a, nbrs] of edges) {
      if (!uncertainSet.has(a)) continue;
      const filtered = new Map(
        [...nbrs].filter(([b, w]) => uncertainSet.has(b) && w >= MIN_EDGE_WEIGHT)
      );
      if (filtered.size > 0) filteredEdges.set(a, filtered);
    }

    // Step 3: PageRank
    const pagerank = nativePageRank(filteredEdges);

    // Step 4: Community detection
    const communities = labelPropagation(filteredEdges);
    console.error(`[graph] ${communities.length} communities detected`);

    // Step 5: Select top-N uncertain seeds per community by PageRank
    const seedGroups = communities.map((members, idx) => {
      const uncertain = members.filter(v => uncertainSet.has(v));
      const seeds = [...uncertain]
        .sort((a, b) => (pagerank.get(b) ?? 0) - (pagerank.get(a) ?? 0))
        .slice(0, seedsPerCluster);
      return { community: idx, size: members.length, seeds };
    }).filter(c => c.seeds.length > 0);

    const allSeeds = seedGroups.flatMap(c => c.seeds);
    console.error(`[graph] ${allSeeds.length} seeds across ${seedGroups.length} communities`);

    // Step 6: LLM-name the seeds
    const namedSeeds = new Map();
    if (llm && process.env.GH_TOKEN && allSeeds.length > 0) {
      const { llmNameBatch } = await import('../llm/copilot.js');
      const BATCH = llmBatchSize;
      for (let i = 0; i < allSeeds.length; i += BATCH) {
        const batch = allSeeds.slice(i, i + BATCH);
        const batchInput = batch.map(varName => ({
          name:    varName,
          context: extractContext(source, varName, 8),
        }));
        try {
          const batchResult = await llmNameBatch(batchInput);
          for (const [mangled, semantic] of Object.entries(batchResult ?? {})) {
            if (semantic && semantic !== mangled) namedSeeds.set(mangled, semantic);
          }
        } catch (e) {
          console.error(`[graph] LLM batch error: ${e.message}`);
        }
        if (i + BATCH < allSeeds.length) await sleep(200);
      }
      for (const [k, v] of namedSeeds) result[k] = v;
      console.error(`[graph] ${namedSeeds.size}/${allSeeds.length} seeds named by LLM`);
    }

    // Step 7: Independent Cascade propagation from named seeds
    let propagatedCount = 0;
    if (namedSeeds.size > 0) {
      const activated = independentCascade(filteredEdges, [...namedSeeds.keys()]);
      const SUFFIXES = ['_ctx', '_peer', '_handler', '_ref', '_alt'];
      let suffixIdx = 0;
      for (const node of activated) {
        if (namedSeeds.has(node) || result[node]) continue;
        if (!uncertainSet.has(node)) continue;
        // Find the highest-ranked seed that connects to this node
        let seedName = null;
        for (const [seed, name] of namedSeeds) {
          const seedNbrs = filteredEdges.get(seed);
          const nodeNbrs = filteredEdges.get(node);
          if ((seedNbrs && seedNbrs.has(node)) || (nodeNbrs && nodeNbrs.has(seed))) {
            seedName = name;
            break;
          }
        }
        if (!seedName) continue;
        const suffix = SUFFIXES[suffixIdx % SUFFIXES.length];
        result[node] = `${seedName}${suffix}`;
        suffixIdx++;
        propagatedCount++;
      }
    }

    const stats = {
      communities: communities.length,
      seeds:       allSeeds.length,
      named:       namedSeeds.size,
      propagated:  propagatedCount,
      total:       Object.keys(result).length,
    };

    console.error(`[graph] done — ${stats.total} new names (${stats.named} LLM + ${stats.propagated} propagated)`);
    return { map: result, stats };

  } catch (e) {
    console.error(`[graph] pipeline error: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    return { map: {}, stats: { error: e.message } };
  }
}

// ── Legacy stubs (kept for external callers) ──────────────────────────────────

/** @deprecated No-op stub — HelixHyper removed. */
export async function buildHelixGraph() {
  return { pushed: 0, edgeCount: 0 };
}

/** @deprecated No-op stub — HelixHyper removed. */
export async function analyzeHelixGraph() {
  return { communities: [], pagerank: new Map() };
}
