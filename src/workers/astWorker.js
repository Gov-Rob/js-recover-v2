/**
 * js-recover — Worker thread: AST analysis tasks
 *
 * Receives a { task, payload } from the main thread, executes the analysis,
 * and posts the result back. Designed to be spawned by pool.js.
 *
 * Supported tasks:
 *   frequencyMap  — Count all identifier frequencies
 *   positional    — Build positional scores for declared variables
 *   cooccurrence  — Build co-occurrence matrix for minified names
 *   entropy       — Compute minification scores for all identifiers
 */

import { workerData, parentPort } from 'worker_threads';
import * as acorn              from 'acorn';
import * as walk               from 'acorn-walk';
import {
  buildFrequencyMap,
  buildPositionalScores,
  buildCooccurrence,
  rankIdentifiers,
  buildTerserIndex,
  minificationScore,
} from '../math/analysis.js';

const { task, payload } = workerData;

async function run() {
  // Parse the AST (each worker parses independently to avoid cross-thread sharing)
  const ast = acorn.parse(payload.source, {
    ecmaVersion: 'latest',
    sourceType:  payload.sourceType ?? 'module',
    allowHashBang: true,
    locations:   false,
  });

  let result;

  switch (task) {
    case 'frequencyMap': {
      const freq = buildFrequencyMap(ast, walk);
      // Serialize: Map → plain object
      result = Object.fromEntries(freq);
      break;
    }

    case 'positional': {
      const scores = buildPositionalScores(ast, walk, payload.source.length);
      result = Object.fromEntries(scores);
      break;
    }

    case 'cooccurrence': {
      const minifiedNames = new Set(payload.minifiedNames ?? []);
      const matrix        = buildCooccurrence(ast, walk, minifiedNames, payload.windowSize ?? 10);
      // Serialize nested Map
      result = Object.fromEntries(
        [...matrix.entries()].map(([k, v]) => [k, Object.fromEntries(v)])
      );
      break;
    }

    case 'entropy': {
      const freq    = buildFrequencyMap(ast, walk);
      const scores  = {};
      for (const [name] of freq) {
        scores[name] = minificationScore(name);
      }
      result = scores;
      break;
    }

    case 'rank': {
      const freq       = buildFrequencyMap(ast, walk);
      const terserIdx  = buildTerserIndex(10000);
      const ranked     = rankIdentifiers(freq, terserIdx);
      result = Object.fromEntries(
        [...ranked.entries()].map(([k, v]) => [k, v])
      );
      break;
    }

    default:
      throw new Error(`Unknown worker task: ${task}`);
  }

  parentPort.postMessage({ ok: true, task, result });
}

run().catch(err => parentPort.postMessage({ ok: false, task, error: err.message }));
