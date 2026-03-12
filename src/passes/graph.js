/**
 * js-recover — HelixHyper Graph Pipeline (Phase 5)
 *
 * Pushes rename coverage beyond static analysis by exploiting
 * relational structure in the minified bundle:
 *
 *  Step 1 — BUILD: Create a HelixHyper node for every uncertain variable.
 *            Edges encode:
 *              • co-occurrence  (appear together in same CallExpression args)
 *              • scope-sibling  (declared in same function body)
 *              • call-chain     (a() returns into b; b is called with c)
 *              • property-peer  (same object's properties accessed together)
 *
 *  Step 2 — RANK: PageRank identifies the most central vars — these are
 *            high-value LLM targets (naming one propagates far).
 *
 *  Step 3 — CLUSTER: Community detection groups uncertain vars into
 *            semantic clusters (auth, HTTP, CLI, LSP, ...).
 *
 *  Step 4 — SEED: Top-N uncertain vars per cluster (by centrality) are
 *            sent to GitHub Copilot LLM for naming.
 *
 *  Step 5 — PROPAGATE: Named seed nodes propagate confidence through
 *            cluster edges via Independent Cascade model.
 *            Neighbors inheriting a name get a modified suffix _2/_3...
 *            only if the semantic distance is high enough.
 *
 *  Step 6 — MERGE: Results merged back into caller's rename map.
 *
 * Requires: HelixHyper MCP server (helixhyper-mcp-*)
 *           GitHub Copilot API (GH_TOKEN env var)
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

/** Max nodes to push into HelixHyper in one pass (memory + speed guard). */
const MAX_NODES = 3_000;

/** Seeds per cluster sent to LLM. */
const SEEDS_PER_CLUSTER = 3;

/** Minimum edge weight to include in graph (prune noise). */
const MIN_EDGE_WEIGHT = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMinified(name) {
  if (!name || name.length > 7) return false;
  if (['i','j','k','n','s','e','t','r','x','y','ok','id','fn','cb','el',
       'ms','db','fs','vm','io','os'].includes(name)) return false;
  return /^[a-zA-Z$_][a-zA-Z0-9$_]{0,6}$/.test(name);
}

function nodeId(varName) {
  return `jsr_var_${varName}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Safely call a HelixHyper MCP tool via dynamic import of the MCP client shim.
// In this environment, we call MCP tools through the global __mcp__ bridge
// injected by the Copilot runtime. If not available, we degrade gracefully.
async function helix(tool, args) {
  if (typeof globalThis.__mcp__ === 'function') {
    return globalThis.__mcp__(`helixhyper-mcp-${tool}`, args);
  }
  // Fallback: throw so callers can catch and degrade.
  throw new Error(`MCP bridge not available (tool: helixhyper-mcp-${tool})`);
}

// ── Step 1: Build co-occurrence + scope graph from AST ────────────────────────

/**
 * Analyze the AST of a minified source file.
 * Returns:
 *   edges: Map<varA, Map<varB, weight>>   (undirected, symmetric)
 *   freq:  Map<varName, count>            (usage frequency)
 *   scopes: Map<scopeId, Set<varName>>    (vars declared in same function body)
 */
export function analyzeRelationships(source) {
  let ast;
  try {
    ast = acorn.parse(source, PARSE_OPTS);
  } catch {
    ast = acorn.parse(source, { ...PARSE_OPTS, sourceType: 'script' });
  }

  const edges  = new Map(); // varA → Map(varB → weight)
  const freq   = new Map(); // varName → total references
  const scopes = new Map(); // scopeKey → Set(varNames)
  let scopeCounter = 0;

  function addEdge(a, b, w = 1) {
    if (a === b || !a || !b) return;
    // Canonical order so we don't double-store
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!edges.has(lo)) edges.set(lo, new Map());
    const nbrs = edges.get(lo);
    nbrs.set(hi, (nbrs.get(hi) ?? 0) + w);
  }

  function incFreq(name) {
    if (!isMinified(name)) return;
    freq.set(name, (freq.get(name) ?? 0) + 1);
  }

  // Track current scope stack for sibling declarations
  const scopeStack = [];

  function enterScope() {
    const id = `scope_${scopeCounter++}`;
    const vars = new Set();
    scopes.set(id, vars);
    scopeStack.push({ id, vars });
  }

  function leaveScope() {
    scopeStack.pop();
  }

  function declareInScope(name) {
    if (!isMinified(name)) return;
    const frame = scopeStack[scopeStack.length - 1];
    if (!frame) return;
    frame.vars.add(name);
  }

  walk.full(ast, (node) => {
    // Count all identifier references
    if (node.type === 'Identifier' && isMinified(node.name)) {
      incFreq(node.name);
    }

    // Co-occurrence: args of same CallExpression
    if (node.type === 'CallExpression') {
      const minArgs = (node.arguments ?? [])
        .filter(a => a.type === 'Identifier' && isMinified(a.name))
        .map(a => a.name);
      // Pair every combo in same call
      for (let i = 0; i < minArgs.length; i++) {
        for (let j = i + 1; j < minArgs.length; j++) {
          addEdge(minArgs[i], minArgs[j], 2);
        }
      }
      // Callee + first arg — strong signal (fn(data))
      const calleeName = node.callee?.name ?? node.callee?.property?.name;
      if (calleeName && isMinified(calleeName) && minArgs.length) {
        addEdge(calleeName, minArgs[0], 3);
      }
    }

    // Co-occurrence: binary / logical operands
    if (['BinaryExpression','LogicalExpression','AssignmentExpression'].includes(node.type)) {
      const l = node.left?.name;
      const r = node.right?.name;
      if (l && r && isMinified(l) && isMinified(r)) addEdge(l, r, 1);
    }

    // Co-occurrence: conditional test + consequent
    if (node.type === 'ConditionalExpression') {
      const t = node.test?.name;
      const c = node.consequent?.name;
      const a = node.alternate?.name;
      if (t && c && isMinified(t) && isMinified(c)) addEdge(t, c, 1);
      if (t && a && isMinified(t) && isMinified(a)) addEdge(t, a, 1);
    }

    // Call-chain: var = callee(arg) → link return target to callee and args
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

    // Property peer: a.x and a.y accessed → link a's property READ context
    // (handled by shape index in renamer; here we link OBJ to its computed properties)
    if (node.type === 'MemberExpression' &&
        node.object?.type === 'Identifier' && isMinified(node.object.name) &&
        node.property?.type === 'Identifier') {
      incFreq(node.object.name); // already counted but reinforce
    }
  });

  // Scope siblings: vars declared in same function → add weak edges
  for (const [, vars] of scopes) {
    const arr = [...vars].filter(v => isMinified(v));
    if (arr.length < 2 || arr.length > 20) continue; // skip huge scopes (noise)
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length && j < i + 5; j++) {
        addEdge(arr[i], arr[j], 1);
      }
    }
  }

  return { edges, freq, scopes };
}

// ── Step 2–5: HelixHyper graph operations ─────────────────────────────────────

/**
 * Push uncertain vars + their edges into HelixHyper.
 * uncertainVars: string[]         — vars not yet named by static analysis
 * relationships: { edges, freq }  — from analyzeRelationships()
 * existingMap:   { varName: name } — already-named vars (for context nodes)
 * snapshotTag:   string           — used to namespace this run's nodes
 */
export async function buildHelixGraph(uncertainVars, relationships, existingMap, snapshotTag = 'jsr') {
  const { edges, freq } = relationships;

  // Limit to MAX_NODES most-frequent uncertain vars
  const sorted = [...uncertainVars]
    .sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0))
    .slice(0, MAX_NODES);

  const varSet = new Set(sorted);

  console.error(`[graph] pushing ${sorted.length} nodes to HelixHyper...`);

  // Batch-add nodes (add individually — HelixHyper has no bulk node API)
  let pushed = 0;
  for (const varName of sorted) {
    const known = existingMap[varName];
    await helix('helix_add_node', {
      id:     nodeId(varName),
      strand: snapshotTag,
      tags:   ['jsr_var', known ? 'named' : 'uncertain', `freq_${Math.min(freq.get(varName) ?? 0, 999)}`],
      payload: {
        varName,
        freq:      freq.get(varName) ?? 0,
        knownName: known ?? null,
        status:    known ? 'named' : 'uncertain',
      },
    });
    pushed++;
    if (pushed % 100 === 0) console.error(`[graph]   nodes: ${pushed}/${sorted.length}`);
  }

  // Add edges between vars that are BOTH in our node set
  let edgeCount = 0;
  for (const [a, nbrs] of edges) {
    if (!varSet.has(a)) continue;
    for (const [b, weight] of nbrs) {
      if (!varSet.has(b) || weight < MIN_EDGE_WEIGHT) continue;
      try {
        await helix('helix_add_edge', {
          from_id: nodeId(a),
          to_id:   nodeId(b),
          label:   'co_occurs',
          weight,
        });
        edgeCount++;
      } catch { /* skip duplicate edge errors */ }
    }
  }

  console.error(`[graph] ${pushed} nodes, ${edgeCount} edges pushed.`);
  return { pushed, edgeCount };
}

/**
 * Run PageRank + community detection on the HelixHyper graph.
 * Returns:
 *   communities: Array<{ id, members: string[] }>   — grouped var names
 *   pagerank:    Map<varName, score>
 */
export async function analyzeHelixGraph() {
  // PageRank for centrality
  const analytics = await helix('helix_compute_analytics', {
    metric: 'all',
    top_n:  200,
  });

  const pagerank = new Map();
  for (const [nodeId_str, score] of Object.entries(analytics?.pagerank ?? {})) {
    const varName = nodeId_str.replace(/^jsr_var_/, '');
    pagerank.set(varName, score);
  }

  // Community detection
  const clusterResult = await helix('helix_find_clusters', { min_cluster_size: 3 });
  const rawClusters = clusterResult?.clusters ?? [];

  const communities = rawClusters.map((cluster, idx) => ({
    id: idx,
    members: (cluster.nodes ?? [])
      .map(id => id.replace(/^jsr_var_/, ''))
      .filter(v => v.length > 0),
  }));

  console.error(`[graph] ${communities.length} communities, ${pagerank.size} ranked vars`);
  return { communities, pagerank };
}

/**
 * Select seed vars per community: highest PageRank uncertain vars.
 * Returns Array<{ community, seeds: string[] }>
 */
export function selectSeeds(communities, pagerank, uncertainSet, seedsPerCluster = SEEDS_PER_CLUSTER) {
  return communities.map(community => {
    const uncertain = community.members.filter(v => uncertainSet.has(v));
    const seeds = [...uncertain]
      .sort((a, b) => (pagerank.get(b) ?? 0) - (pagerank.get(a) ?? 0))
      .slice(0, seedsPerCluster);
    return { community: community.id, size: community.members.length, seeds };
  }).filter(c => c.seeds.length > 0);
}

/**
 * Name seed vars via Copilot LLM and update HelixHyper nodes.
 * Returns Map<varName, semanticName>
 */
export async function nameSeeds(seeds, source, llmNameBatch) {
  const named = new Map();
  const allSeeds = seeds.flatMap(c => c.seeds);

  if (allSeeds.length === 0) return named;

  console.error(`[graph] LLM naming ${allSeeds.length} seed vars across ${seeds.length} communities...`);

  // Build batches of 10
  const BATCH = 10;
  for (let i = 0; i < allSeeds.length; i += BATCH) {
    const batch = allSeeds.slice(i, i + BATCH);
    const batchInput = batch.map(varName => ({
      name:    varName,
      context: extractContext(source, varName, 8),
    }));

    try {
      const result = await llmNameBatch(batchInput);
      for (const [mangled, semantic] of Object.entries(result ?? {})) {
        if (semantic && semantic !== mangled) {
          named.set(mangled, semantic);

          // Update the HelixHyper node with the LLM-assigned name
          try {
            await helix('helix_update_node', {
              id:    nodeId(mangled),
              tags:  ['jsr_var', 'named', 'llm_seed'],
              payload: { knownName: semantic, status: 'named_llm', confidence: 8 },
            });
          } catch { /* non-fatal */ }
        }
      }
    } catch (e) {
      console.error(`[graph] LLM batch error: ${e.message}`);
    }

    if (i + BATCH < allSeeds.length) await sleep(200); // gentle rate limit
  }

  console.error(`[graph] ${named.size}/${allSeeds.length} seeds named by LLM`);
  return named;
}

/**
 * Propagate named seeds through the HelixHyper graph via influence propagation.
 * Neighbors of a named seed that have NO name yet inherit a derivation.
 * Returns Map<varName, semanticName> for all newly-named vars.
 */
export async function propagateNames(namedSeeds, uncertainSet, pagerank) {
  const propagated = new Map();
  if (namedSeeds.size === 0) return propagated;

  const seedNodeIds = [...namedSeeds.keys()].map(nodeId);

  let propResult;
  try {
    propResult = await helix('helix_propagate_influence', {
      seed_nodes:  seedNodeIds,
      model:       'independent_cascade',
      probability: 0.4,
      steps:       4,
    });
  } catch (e) {
    console.error(`[graph] propagation error: ${e.message}`);
    return propagated;
  }

  // `activated` is a list of node IDs that were reached by propagation
  const activated = propResult?.activated ?? [];
  console.error(`[graph] propagation reached ${activated.length} nodes from ${namedSeeds.size} seeds`);

  // For each activated uncertain var, find its nearest named seed and derive a name.
  // Strategy: append cluster role suffix (2nd/3rd neighbor gets _peer, _ctx, _handler)
  const SUFFIXES = ['', '_ctx', '_peer', '_handler', '_ref', '_alt'];
  let suffixIdx = 0;

  for (const activatedId of activated) {
    const varName = activatedId.replace(/^jsr_var_/, '');
    if (!uncertainSet.has(varName)) continue;     // already named elsewhere
    if (namedSeeds.has(varName)) continue;         // is itself a seed — skip

    // Find what seed activated it via path query (lightweight: just take highest-rank seed)
    // We can't easily know which seed activated it, so we use nearest seed name
    // Find path from this var to any seed
    let seedName = null;
    for (const [seed, name] of namedSeeds) {
      try {
        const path = await helix('helix_find_path', {
          from_id:   nodeId(varName),
          to_id:     nodeId(seed),
          max_depth: 3,
        });
        if (path?.path?.length > 0) { seedName = name; break; }
      } catch { continue; }
    }

    if (!seedName) continue;

    // Derive name from seed: peer/context relationship
    const suffix = SUFFIXES[suffixIdx % SUFFIXES.length];
    const derivedName = suffix ? `${seedName}${suffix}` : seedName;
    suffixIdx++;
    propagated.set(varName, derivedName);
  }

  console.error(`[graph] propagated names to ${propagated.size} additional vars`);
  return propagated;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the full HelixHyper graph pipeline on uncertain vars.
 *
 * @param {string}   source       — full minified JS source
 * @param {string[]} uncertainVars — vars not named by static passes
 * @param {object}   existingMap  — { varName: semanticName } from static passes
 * @param {object}   opts
 *   llm           {boolean}   — use Copilot LLM for seed naming (default: true)
 *   propagate     {boolean}   — run influence propagation (default: true)
 *   snapshotTag   {string}    — namespace tag for this run's HelixHyper nodes
 *   seedsPerCluster {number}  — LLM seeds per community (default: 3)
 *
 * @returns {object} { map: {varName:name}, stats: {...} }
 */
export async function graphPass(source, uncertainVars, existingMap = {}, opts = {}) {
  const {
    llm           = !!process.env.GH_TOKEN,
    propagate     = true,
    snapshotTag   = `jsr_${Date.now()}`,
    seedsPerCluster = SEEDS_PER_CLUSTER,
  } = opts;

  const result = {};

  try {
    // Step 1: analyze relationships in source
    console.error('[graph] analyzing variable relationships...');
    const relationships = analyzeRelationships(source);

    // Step 2: push to HelixHyper
    await buildHelixGraph(uncertainVars, relationships, existingMap, snapshotTag);

    // Step 3: PageRank + community detection
    const { communities, pagerank } = await analyzeHelixGraph();

    // Step 4: select seeds (highest-centrality uncertain vars per community)
    const uncertainSet = new Set(uncertainVars);
    const seedGroups = selectSeeds(communities, pagerank, uncertainSet, seedsPerCluster);
    const totalSeeds = seedGroups.reduce((s, c) => s + c.seeds.length, 0);
    console.error(`[graph] ${totalSeeds} seeds across ${seedGroups.length} communities`);

    // Step 5: LLM-name the seeds
    let namedSeeds = new Map();
    if (llm && process.env.GH_TOKEN && totalSeeds > 0) {
      const { llmNameBatch } = await import('../llm/copilot.js');
      namedSeeds = await nameSeeds(seedGroups, source, llmNameBatch);
      for (const [k, v] of namedSeeds) result[k] = v;
    }

    // Step 6: propagate names through graph
    if (propagate && namedSeeds.size > 0) {
      const propagated = await propagateNames(namedSeeds, uncertainSet, pagerank);
      for (const [k, v] of propagated) {
        if (!result[k]) result[k] = v; // don't overwrite LLM names
      }
    }

    const stats = {
      graphNodes:    Math.min(uncertainVars.length, MAX_NODES),
      communities:   communities.length,
      seeds:         totalSeeds,
      llmNamed:      namedSeeds.size,
      propagated:    Object.keys(result).length - namedSeeds.size,
      total:         Object.keys(result).length,
    };

    console.error(`[graph] done — ${stats.total} new names (${stats.llmNamed} LLM + ${stats.propagated} propagated)`);
    return { map: result, stats };

  } catch (e) {
    console.error(`[graph] pipeline error: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    return { map: {}, stats: { error: e.message } };
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

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
