/**
 * js-recover — Worker thread pool
 *
 * Spawns N workers (default: CPU count) and distributes analysis tasks.
 * Each task runs in its own worker thread; results are collected asynchronously.
 * Workers are re-used across tasks (pool).
 *
 * Usage:
 *   import { runTasks } from './pool.js';
 *   const [freq, pos] = await runTasks(source, ['frequencyMap', 'positional']);
 */

import { Worker } from 'worker_threads';
import { cpus }  from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH  = join(__dirname, 'astWorker.js');
const MAX_WORKERS  = Math.min(cpus().length, 8);  // cap at 8 for memory safety

/**
 * Spawn a single worker for one task and collect its result.
 * @param {string} task
 * @param {object} payload  { source, ...opts }
 * @returns {Promise<any>}
 */
function spawnWorker(task, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { task, payload } });

    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Worker task '${task}' timed out after 120s`));
    }, 120_000);

    worker.on('message', msg => {
      clearTimeout(timeout);
      worker.terminate();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(`Worker task '${task}' failed: ${msg.error}`));
    });

    worker.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Run multiple AST analysis tasks in parallel (up to MAX_WORKERS at once).
 * All tasks receive the same source string.
 *
 * @param {string} source  JavaScript source code
 * @param {string[]} tasks  Names of tasks to run (see astWorker.js)
 * @param {object} [opts]   Extra options passed to workers
 * @returns {Promise<any[]>}  Results in same order as tasks array
 */
export async function runTasks(source, tasks, opts = {}) {
  const sourceType = opts.sourceType ?? 'module';

  // Dispatch all tasks simultaneously
  const promises = tasks.map(task =>
    spawnWorker(task, { source, sourceType, ...opts })
  );

  return Promise.all(promises);
}

/**
 * Run the full analysis suite (all 4 tasks) in parallel.
 * Returns an object with all results keyed by task name.
 * @param {string} source
 * @param {string[]} minifiedNames
 * @param {object} [opts]
 * @returns {Promise<{ frequencyMap, positional, entropy, rank }>}
 */
export async function runFullAnalysis(source, minifiedNames = [], opts = {}) {
  const tasks = ['frequencyMap', 'positional', 'entropy', 'rank'];
  const extra = minifiedNames.length ? { minifiedNames } : {};

  const results = await runTasks(source, tasks, { ...opts, ...extra });

  return {
    frequencyMap: results[0],
    positional:   results[1],
    entropy:      results[2],
    rank:         results[3],
  };
}

export { MAX_WORKERS };
