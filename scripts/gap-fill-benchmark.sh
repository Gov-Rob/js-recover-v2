#!/usr/bin/env bash
# gap-fill-benchmark.sh — Fresh benchmark with no stale results.
# Usage: ./scripts/gap-fill-benchmark.sh
# Always run AFTER injection is complete in a fresh shell.
set -e
cd "$(dirname "$0")/.."
node --input-type=module -e "
import { buildRenameMap } from './src/passes/renamer.js';
import { readFileSync } from 'fs';
const r = await buildRenameMap(readFileSync('/root/copilot-src/app.stripped.js','utf8'), {llm:false,workers:false});
const s = r.stats;
const pct = (s.static/s.bindings*100).toFixed(1);
console.log('Coverage: ' + s.static + '/' + s.bindings + ' = ' + pct + '%  |  uncertain: ' + s.uncertain);
" 2>/dev/null
