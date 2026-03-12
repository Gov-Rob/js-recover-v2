/**
 * multi-model-batch.mjs — LLM naming runner
 * 
 * Strategy: Local Ollama first (no quota), fallback to GitHub Copilot API.
 * Ollama models: mistral-nemo, llama3.1, mistral
 * Copilot: requires GHU_TOKEN env var (device auth ghu_ token)
 * 
 * LEARNING: Business proxy requires stream:true; regular endpoint may hit quota.
 * LEARNING: Ollama mistral-nemo produces ~10-30 names per 10-var chunk reliably.
 * LEARNING: Context array must be joined before slicing.
 * LEARNING: Run 3 batches in parallel (& background) for 3x throughput.
 * LEARNING: Each 100-var batch takes ~15-20 min on mistral-nemo with GPU.
 * LEARNING: Net yield after filter ~55% (50-70 accepted per 100-var batch).
 * LEARNING: Always benchmark in a FRESH node process AFTER injection completes.
 *           A background benchmark started before injection sees the old renamer.js.
 * LEARNING: Second pass (after first-pass pool exhaustion) yields +0.6-0.9% per
 *           3-batch round vs +0.8-1.0% in first pass (remaining vars are harder).
 * LEARNING: mistral-nemo:latest is most reliable for JSON output; llama3.1 drifts.
 * LEARNING: After 89%+ coverage, popular name slots fill up. Add numeric suffix
 *           fallback (name2..name9) in filter_batch() — lifts yield 0% → 35%.
 * LEARNING: val-clash dedup must be CASE-SENSITIVE. Case-insensitive blocks too many.
 */
import { readFileSync, writeFileSync } from 'fs';

const OLLAMA = 'http://127.0.0.1:11434';
const OLLAMA_MODELS = ['mistral-nemo:latest', 'llama3.1:latest', 'mistral:latest'];
const GHU_TOKEN = process.env.GHU_TOKEN || process.env.GITHUB_TOKEN || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Copilot session (lazy-init, auto-refresh)
let _sess = null, _sessExp = 0;
async function getCopilotSession() {
  const now = Math.floor(Date.now()/1000);
  if (_sess && now < _sessExp - 60) return _sess;
  const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { 'Authorization': 'token ' + GHU_TOKEN, 'Accept': 'application/json',
      'Editor-Version': 'vscode/1.85.0', 'User-Agent': 'GitHubCopilotChat/0.20.3' }
  });
  const data = await resp.json();
  if (!data.token) throw new Error('No copilot token: ' + JSON.stringify(data).slice(0,100));
  // NOTE: business proxy requires stream:true; use api.githubcopilot.com for non-streaming
  _sess = { token: data.token, endpoint: 'https://api.githubcopilot.com/chat/completions' };
  const m = data.token.match(/exp=(\d+)/);
  _sessExp = m ? parseInt(m[1]) : now + 1400;
  return _sess;
}

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const raw = (fence ? fence[1] : text).trim();
  const full = raw.match(/\{[\s\S]*\}/);
  if (full) { try { return JSON.parse(full[0]); } catch(_) {} }
  const pairs = {};
  const re = /"([^"]{2,6})"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) pairs[m[1]] = m[2];
  if (Object.keys(pairs).length > 0) return pairs;
  throw new Error('No JSON: ' + text.slice(0,60));
}

function buildPrompt(vars) {
  const parts = [];
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    const ctx = Array.isArray(v.context) ? v.context.join('\n') : (v.context || '');
    parts.push('### ' + v.name + '\n' + ctx.slice(0, 500));
  }
  return 'You are an expert JavaScript reverse engineer. Analyze each minified variable name and its usage context. Return ONLY a raw JSON object mapping each minified name to a descriptive camelCase name. No explanation, no markdown fences.\n\nExample: {"abc": "itemCount", "xFn": "getUser"}\n\n' + parts.join('\n\n') + '\n\nReturn ONLY the JSON:';
}

async function llmOllama(vars, model) {
  const resp = await fetch(OLLAMA + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: buildPrompt(vars), stream: false,
      options: { temperature: 0.1, num_predict: 1500 } }),
  });
  if (!resp.ok) throw new Error('Ollama HTTP ' + resp.status);
  const data = await resp.json();
  return extractJSON(data.response || '');
}

async function llmCopilot(vars, model) {
  if (!GHU_TOKEN) throw new Error('No GHU_TOKEN set');
  const sess = await getCopilotSession();
  const resp = await fetch(sess.endpoint, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + sess.token, 'Content-Type': 'application/json',
      'Copilot-Integration-Id': 'vscode-chat', 'Editor-Version': 'vscode/1.85.0' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: buildPrompt(vars) }], max_tokens: 2000 }),
  });
  if (!resp.ok) throw new Error('Copilot HTTP ' + resp.status + ' ' + (await resp.text()).slice(0,80));
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content');
  return extractJSON(content);
}

async function runBatch(inputFile, outputFile) {
  const vars = JSON.parse(readFileSync(inputFile, 'utf8'));
  const CHUNK = 10;
  const results = {};
  let passed = 0, failed = 0;

  console.log('[runner] ' + vars.length + ' vars, chunk=' + CHUNK);
  for (let i = 0; i < vars.length; i += CHUNK) {
    const chunk = vars.slice(i, i + CHUNK);
    const prog = '[' + Math.min(i + CHUNK, vars.length) + '/' + vars.length + ']';
    let success = false;

    // Try Ollama first (local, no quota)
    for (const model of OLLAMA_MODELS) {
      try {
        const res = await llmOllama(chunk, model);
        Object.assign(results, res);
        process.stdout.write('\r' + prog + ' ollama/' + model.split(':')[0] + ' +' + Object.keys(res).length + '    ');
        passed++; success = true; break;
      } catch(e) {
        await sleep(300);
      }
    }

    // Fallback: Copilot API
    if (!success && GHU_TOKEN) {
      for (const model of ['gpt-4o-2024-11-20', 'claude-opus-4.6']) {
        try {
          const res = await llmCopilot(chunk, model);
          Object.assign(results, res);
          process.stdout.write('\r' + prog + ' copilot/' + model.slice(0,15) + ' +' + Object.keys(res).length + '    ');
          passed++; success = true; break;
        } catch(e) {
          await sleep(1000);
        }
      }
    }

    if (!success) { failed++; process.stdout.write('\r' + prog + ' FAILED\n'); }
  }
  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log('\nDone: ' + passed + ' ok, ' + failed + ' failed -> ' + Object.keys(results).length + ' raw names');
}

const [,, inputFile, outputFile] = process.argv;
if (!inputFile || !outputFile) { console.error('Usage: node multi-model-batch.mjs <input> <output>'); process.exit(1); }
runBatch(inputFile, outputFile).catch(e => { console.error(e); process.exit(1); });
