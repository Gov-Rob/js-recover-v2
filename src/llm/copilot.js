/**
 * js-recover — GitHub Copilot LLM backend
 *
 * Auth: GitHub device auth (GH_TOKEN) → Copilot session token (30-min TTL).
 * Models: auto-selects Opus 4.6 (200K ctx) when available, falls back to gpt-4o.
 * Batching: Opus can handle ALL uncertain vars in 1-3 calls; smaller models use
 *           the legacy 15-var batches. Batch size is auto-tuned per model.
 */

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_API_URL   = 'https://api.business.githubcopilot.com/chat/completions';
const COPILOT_MODELS_URL = 'https://api.business.githubcopilot.com/models';
const TOKEN_TTL_MS      = 25 * 60 * 1000; // refresh 5 min before expiry

// Model preference order — Opus first for quality, then fallbacks
const MODEL_PREFERENCE = [
  'claude-opus-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'gpt-4o',
  'gpt-4o-mini',
];

// Copilot's Opus endpoint has a 128K *input* token limit.
// Code is token-dense (~1 token per 3.5 chars). With prompt overhead (~500 tok),
// target ≤ 90K input tokens per call to leave room for output.
//   Opus:   90000 / (600chars/3.5 + 50overhead) ≈ 90000/221 ≈ 407 vars  → use 200 safely
//   Sonnet: same limits via Copilot → use 150
//   gpt-4o: 128K window → use 100
const MODEL_PROFILES = {
  // contextPerVar: max chars per var in LLM prompt (matches extractContextMulti: 5×400=2000)
  // batchSize:    vars per API call — (ctxWindow×3.5×0.70 - overhead) / contextPerVar
  //   Opus:    (128K×3.5×0.70 - 3000) / 2000 ≈ 155 → use 80 for quality focus
  //   Sonnet:  same window, slightly less context → 60
  //   gpt-4o:  (128K×3.5×0.70 - 3000) / 1600 ≈ 195 → use 60
  //   mini:    (128K×3.5×0.60 - 2000) / 1000 ≈ 267 → use 30
  'claude-opus':   { ctxWindow: 128_000, contextPerVar: 2000, batchSize: 50,  maxOut: 16000 },
  'claude-sonnet': { ctxWindow: 128_000, contextPerVar: 1600, batchSize: 60,  maxOut: 12000 },
  'gpt-4o':        { ctxWindow: 128_000, contextPerVar: 1600, batchSize: 60,  maxOut: 6000  },
  'gpt-4o-mini':   { ctxWindow: 128_000, contextPerVar: 1000, batchSize: 30,  maxOut: 3000  },
  'default':       { ctxWindow: 32_000,  contextPerVar: 600,  batchSize: 10,  maxOut: 1200  },
};

let _token     = null;
let _tokenExp  = 0;
let _model     = null;  // resolved once per session

function getProfile(model) {
  if (!model) return MODEL_PROFILES.default;
  if (model.includes('opus'))   return MODEL_PROFILES['claude-opus'];
  if (model.includes('sonnet')) return MODEL_PROFILES['claude-sonnet'];
  if (model.includes('gpt-4o-mini')) return MODEL_PROFILES['gpt-4o-mini'];
  if (model.includes('gpt-4o'))      return MODEL_PROFILES['gpt-4o'];
  return MODEL_PROFILES.default;
}

/**
 * Exchange GitHub OAuth token for a live Copilot session token.
 */
async function fetchCopilotToken(ghToken) {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      'Authorization':        `token ${ghToken}`,
      'Editor-Version':       'vscode/1.85.0',
      'Editor-Plugin-Version':'copilot/1.0',
    },
  });
  if (!res.ok) throw new Error(`Copilot auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, expiresAt: data.expires_at * 1000 };
}

/**
 * Get a valid Copilot session token, refreshing if needed.
 */
async function getToken() {
  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN not set — required for Copilot LLM pass');
  const now = Date.now();
  if (!_token || now >= _tokenExp - TOKEN_TTL_MS) {
    const t  = await fetchCopilotToken(ghToken);
    _token   = t.token;
    _tokenExp = t.expiresAt;
  }
  return _token;
}

/**
 * Resolve the best available model from the Copilot models endpoint.
 * Cached for the session lifetime.
 */
async function resolveModel() {
  if (_model) return _model;
  try {
    const token = await getToken();
    const res = await fetch(COPILOT_MODELS_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Editor-Version': 'vscode/1.85.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
    });
    if (res.ok) {
      const data = await res.json();
      const available = new Set(
        (data.data ?? data.models ?? data).map(m => m.id ?? m.name ?? m)
      );
      for (const m of MODEL_PREFERENCE) {
        if (available.has(m)) { _model = m; break; }
      }
    }
  } catch { /* fall through */ }
  _model = _model ?? 'gpt-4o-mini';
  if (process.env.DEBUG) console.error(`[llm] model resolved → ${_model}`);
  return _model;
}

/**
 * Send a chat completion request to Copilot.
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number }} opts
 */
export async function copilotChat(prompt, { model, maxTokens } = {}) {
  const token = await getToken();
  const m = model ?? await resolveModel();
  const profile = getProfile(m);
  const outTokens = maxTokens ?? profile.maxOut;

  const res = await fetch(COPILOT_API_URL, {
    method:  'POST',
    headers: {
      'Authorization':         `Bearer ${token}`,
      'Content-Type':          'application/json',
      'Editor-Version':        'vscode/1.85.0',
      'Copilot-Integration-Id':'vscode-chat',
    },
    body: JSON.stringify({
      model: m,
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  outTokens,
      temperature: 0.05,
    }),
  });

  if (!res.ok) throw new Error(`Copilot API ${res.status} (${m}): ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Parse a JSON rename map from LLM text.
 * Opus sometimes emits multiple JSON blocks (first a wrong attempt, then the correct one).
 * Strategy: extract ALL top-level {...} blocks, try each, and pick the one whose keys
 * look most like minified identifiers (short, alphanumeric).
 */
function parseRenameJson(text, mangledNames) {
  // Collect all {...} top-level blocks
  const blocks = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) { blocks.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  if (!blocks.length) return {};

  // Score each block by how many keys look like minified var names
  const mangledSet = mangledNames ? new Set(mangledNames) : null;
  let best = null, bestScore = -1;
  for (const block of blocks) {
    let parsed;
    try { parsed = JSON.parse(block); } catch { continue; }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    // Score: count keys that are in mangledSet (or look minified if no set)
    const score = Object.keys(parsed).filter(k =>
      mangledSet ? mangledSet.has(k) : /^[a-zA-Z$_][a-zA-Z0-9$_]{0,6}$/.test(k)
    ).length;
    if (score > bestScore) { best = parsed; bestScore = score; }
  }

  if (!best) {
    // Fallback: extract key:value pairs with regex from the largest block
    const largest = blocks.sort((a, b) => b.length - a.length)[0];
    const result = {};
    const re = /"([^"]+)"\s*:\s*(?:"([^"]*)"|(null))/g;
    let m;
    while ((m = re.exec(largest)) !== null) result[m[1]] = m[3] === 'null' ? null : m[2];
    return result;
  }
  return best;
}

/**
 * Name a batch of uncertain variables using the best available Copilot model.
 * With Opus (200K ctx), this can handle 300+ vars in a single call.
 *
 * @param {{ name: string, context: string }[]} batch
 * @returns {Promise<Record<string,string>>}  mangled → semantic
 */
/**
 * @param {{ name: string, context: string }[]} batch
 * @param {{ aggressive?: boolean }} [opts]
 */
export async function llmNameBatch(batch, opts = {}) {
  if (!batch.length) return {};

  const model = await resolveModel();
  const profile = getProfile(model);

  const isAggressive = opts.aggressive ?? false;

  const prompt = isAggressive
    ? `You are a JavaScript variable renamer. These variables resisted confident naming in a prior pass. Use structural heuristics to assign a plausible name to EVERY variable — do not return null.

RULES:
- Output ONLY valid JSON: {"mangledName": "semanticName"}
- camelCase (or PascalCase for classes), max 25 chars, valid JS identifier
- Use these pattern conventions if context is sparse:
    callbacks/event handlers → handler, callback, cb, listener, fn
    config/options objects   → opts, config, cfg, settings, options
    error values             → err, error
    result/return values     → result, value, val, ret
    counters/indices         → i, idx, count, index
    boolean flags            → flag, enabled, active, isReady
    string/message           → msg, str, text, label
    array/list               → items, list, arr, entries, values
    map/object               → map, obj, data, record, table
    node/element             → node, el, element, target
    state                    → state, ctx, context
- NEVER output the original mangled name or null — always provide a plausible alternative
- No markdown, no explanation — raw JSON only

VARIABLES:
${batch.map(b => `### ${b.name}\n\`\`\`js\n${b.context.slice(0, profile.contextPerVar)}\n\`\`\``).join('\n\n')}`
    : `You are an expert JavaScript reverse-engineer. Given minified variable names and their surrounding source code, produce precise, readable camelCase names.

RULES:
- Output ONLY valid JSON: {"mangledName": "semanticName" | null}
- camelCase, max 30 chars, valid JS identifier
- Be SPECIFIC: prefer "requestHandler" over "fn", "configRegistry" over "obj"
- If a var is a class/constructor use PascalCase
- Return null only if truly unresolvable (loop counters, temp vars with no signal)
- No markdown, no explanation — raw JSON only

VARIABLES:
${batch.map(b => `### ${b.name}\n\`\`\`js\n${b.context.slice(0, profile.contextPerVar)}\n\`\`\``).join('\n\n')}`;

  const text = await copilotChat(prompt, { model, maxTokens: batch.length * 40 + 200 });
  const mangledNames = batch.map(b => b.name);
  const parsed = parseRenameJson(text, mangledNames);

  return Object.fromEntries(
    Object.entries(parsed).filter(
      ([, v]) => v && typeof v === 'string' && /^[a-zA-Z_$][a-zA-Z0-9_$]{1,30}$/.test(v)
    )
  );
}

/**
 * Get the auto-resolved model name (for callers that need to know batch sizing).
 */
export async function getActiveModel() {
  return resolveModel();
}

/**
 * Get the profile (batchSize, contextPerVar, etc.) for the active model.
 */
export async function getActiveProfile() {
  return getProfile(await resolveModel());
}

export { getToken };
