/**
 * js-recover — Renamer pass (v6)
 *
 * Seven-phase pipeline:
 *   Phase 1 — INIT analysis     (what is this variable initialized to?)
 *   Phase 2 — USAGE analysis    (single-pass O(n) — how is it used?)
 *   Phase 2b— SHAPE analysis    (what properties are read from this var?)
 *   Phase 2c— DESTRUCT analysis (what keys are destructured out of this var?)
 *   Phase 2d— CALL-ARG analysis (what type is inferred from call-site position?)
 *   Phase 2e— ALIAS analysis   (type propagation via assignment aliasing)
 *   Phase 2f— RETURN TYPE      (function return type inference + propagation)
 *   Phase 2g— SYMBOL ANALYSIS  (Symbol.for/Symbol keys, class declarations,
 *                                RegExp patterns, string-literal semantics)
 *   Phase 3 — MATH analysis     (frequency rank, Terser sequence, entropy)
 *   Phase 4 — COPILOT LLM       (batch uncertain vars to GitHub Copilot)
 *   Phase 5 — HELIX GRAPH       (co-occurrence graph, community detection,
 *                                 influence propagation via HelixHyper)
 *
 * Phases 1+2 run in the main thread (fast, synchronous acorn walk).
 * Phase 3 runs in parallel worker threads (one per analysis type on large files).
 * Phase 4 runs async via GitHub Copilot API (batched, token auto-refreshed).
 * Phase 5 runs async via HelixHyper MCP (requires MCP bridge).
 */
import * as acorn from 'acorn';
import * as walk  from 'acorn-walk';
import { readFileSync as _readFileSync } from 'fs';

const PARSE_OPTS = {
  ecmaVersion:                 'latest',
  sourceType:                  'module',
  allowHashBang:               true,
  allowImportExportEverywhere: true,
  locations:                   false,
};

// ── Utilities ─────────────────────────────────────────────────────────────────

const ALWAYS_SKIP = new Set([
  'i','j','k','n','s','e','t','r','x','y','ok','id','fn','cb','el',
  'ms','db','fs','vm','io','os','if','do','in','of','to','is','on',
  'by','at','up','go','no','me','my','we',
]);

function isMinified(name) {
  if (name.length > 7) return false;
  if (ALWAYS_SKIP.has(name)) return false;
  return /^[a-zA-Z$_][a-zA-Z0-9$_]{0,5}$/.test(name);
}

function toIdentifier(raw) {
  const clean = raw.replace(/[^a-zA-Z0-9_$]/g, '_');
  return /^[a-zA-Z_$]/.test(clean) ? clean : `_${clean}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a Symbol.for() key string to a clean identifier name.
 * e.g. "undici.error.UND_ERR_CONNECT_TIMEOUT" → "sym_undici_connectTimeout"
 *      "nodejs.rejection" → "sym_nodejsRejection"
 */
function symbolKeyToName(key) {
  // Split on dots and underscores, camelCase the result
  const parts = key.split(/[._\s-]+/).filter(Boolean);
  if (!parts.length) return 'namedSym';
  // Take up to last 3 meaningful segments (skip generic prefixes like 'err')
  const meaningful = parts.filter(p => p.length > 1 && !/^(the|a|an|of|for|in|on|by)$/i.test(p));
  const segments = meaningful.slice(-3);
  if (!segments.length) return 'namedSym';
  const camel = segments
    .map((s, i) => {
      const lower = s.toLowerCase().replace(/[^a-z0-9]/g, '');
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
  return `sym_${camel.slice(0, 28)}`;
}

/**
 * Convert a descriptive string literal to a semantic identifier name.
 * e.g. "Connect Timeout Error" → "connectTimeoutMsg"
 *      "connection closed"     → "connectionClosedMsg"
 * Returns null if the string isn't descriptive enough.
 */
function stringLiteralToName(str) {
  if (!str || str.length < 5 || str.length > 80) return null;
  if (!/[a-zA-Z]{3}/.test(str)) return null; // mostly numbers/symbols
  // Natural-language phrase (spaces)
  if (/\s/.test(str)) {
    const words = str.split(/\s+/).filter(w => /^[A-Za-z][a-z]{1,}$/.test(w));
    if (words.length >= 2) {
      const camel = words.slice(0, 3)
        .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('');
      return camel.slice(0, 30) + 'Msg';
    }
  }
  // Path-like: /some/path → already handled upstream
  // Short descriptive event/status names without spaces
  if (/^[a-z][a-zA-Z0-9]{3,20}$/.test(str) && /[A-Z]|[_-]/.test(str)) {
    return 'K_' + str.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
  }
  return null;
}

/**
 * Extract multiple occurrence snippets of `varName` from source for richer LLM context.
 * Returns up to `maxOcc` distinct line-level snippets joined by ' | '.
 */
function extractContextMulti(source, varName, maxOcc = 3, radius = 500) {
  const re = new RegExp(`\\b${varName}\\b`, 'g');
  const snippets = new Set();
  let m;
  while ((m = re.exec(source)) !== null && snippets.size < maxOcc) {
    const start = Math.max(0, m.index - radius);
    const end   = Math.min(source.length, m.index + varName.length + radius);
    const snip  = source.slice(start, end).trim().replace(/\s+/g, ' ').slice(0, 240);
    snippets.add(snip);
  }
  return [...snippets].join(' | ');
}

// ── Phase 1: Initializer scoring ──────────────────────────────────────────────

const HIGH_PRIO_CTORS = new Set([
  'Map','Set','WeakMap','WeakSet','Promise','Error','TypeError','RangeError',
  'Date','URL','URLSearchParams','RegExp','EventEmitter','Buffer',
  'AbortController','Worker','SharedArrayBuffer',
]);

function scoreInit(init) {
  if (!init) return null;

  switch (init.type) {
    case 'Literal': {
      const v = init.value;
      if (typeof v === 'string') {
        if (/^\/[a-z][a-z0-9-/]*$/.test(v))
          return { name: 'CMD_' + v.slice(1).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase().slice(0,24), score: 10 };
        if (/^[A-Z_]{2,20}$/.test(v))
          return { name: 'K_' + v.slice(0, 24), score: 8 };
        if (/^[a-z][a-zA-Z0-9._-]{2,30}$/.test(v))
          return { name: 'K_' + toIdentifier(v).slice(0, 26), score: 7 };
        // Descriptive natural-language message strings
        const descName = stringLiteralToName(v);
        if (descName) return { name: descName, score: 6 };
        // Fallback: any string literal → generic 'str' hint
        if (v.length >= 1) return { name: 'str', score: 3 };
      }
      if (typeof v === 'boolean') return { name: v ? 'enabled' : 'disabled', score: 3 };
      if (typeof v === 'number') {
        if (Number.isInteger(v) && v >= 0 && v < 100000)
          return { name: `N_${v}`, score: 3 };
        return { name: 'num', score: 3 }; // fallback for floats/large ints
      }
      // RegExp literal: /pattern/ → regex signal
      if (init.regex) return { name: 'rePattern', score: 5 };
      return null;
    }

    case 'ClassExpression': {
      // const Foo = class { ... } — always a constructor/class definition
      const nm = init.id?.name;
      return nm
        ? { name: nm.charAt(0).toLowerCase() + nm.slice(1) + 'Class', score: 8 }
        : { name: 'classDef', score: 7 };
    }

    case 'NewExpression': {
      // Handle both: new Ctor() and new obj.Ctor()
      const cls = init.callee?.name ?? init.callee?.property?.name;
      if (!cls) return null;
      const base = cls.charAt(0).toLowerCase() + cls.slice(1);
      return {
        name:  HIGH_PRIO_CTORS.has(cls) ? base : `${base}Inst`,
        score: HIGH_PRIO_CTORS.has(cls) ? 9 : 5,
      };
    }

    case 'ArrayExpression':
      return { name: 'items', score: 4 };

    case 'ObjectExpression': {
      const keys = init.properties
        .filter(p => p.key?.type === 'Identifier' && /^[a-z]{3,}/i.test(p.key.name))
        .map(p => p.key.name);
      return {
        name:  keys.length ? `obj_${keys[0].slice(0,16)}` : 'config',
        score: keys.length ? 6 : 4,
      };
    }

    case 'CallExpression': {
      const { callee, arguments: args } = init;

      // require() — highest confidence
      if (callee?.name === 'require' && args?.[0]?.type === 'Literal') {
        const mod = String(args[0].value).split('/').pop().replace(/\W/g, '_');
        return { name: `mod_${mod.slice(0,20)}`, score: 9 };
      }

      // Lazy module initializer: R(()=>{...}) or S(()=>{...})
      // These are esbuild/rollup lazy-init wrappers. Name from factory body exports.
      if ((callee?.name === 'R' || callee?.name === 'S') &&
          args?.[0] && (args[0].type === 'ArrowFunctionExpression' || args[0].type === 'FunctionExpression')) {
        const factory = args[0];
        const GENERIC_KEYS = new Set([
          'exports','default','index','module','string','buffer','object','number',
          'length','value','values','entries','keys','items','list','array','result',
          'middle','state','props','config','options','context','version','source',
          'target','parent','child','current','last','first','next','prev','self',
        ]);
        // Collect export property keys from factory: obj.KEY = value
        const longKeys = [];
        function collectExportKeys(body) {
          if (!body) return;
          const stmts = Array.isArray(body) ? body : (body.body ?? []);
          for (const stmt of stmts) {
            const expr = stmt.type === 'ExpressionStatement' ? stmt.expression : null;
            if (expr?.type === 'AssignmentExpression' &&
                expr.left?.type === 'MemberExpression' &&
                expr.left.property?.type === 'Identifier') {
              const key = expr.left.property.name;
              if (key.length >= 5 && !GENERIC_KEYS.has(key)) {
                longKeys.push(key);
              }
            }
          }
        }
        collectExportKeys(factory.body?.body ?? factory.body);
        if (longKeys.length > 0) {
          // Pick the most descriptive key (longest, prefer camelCase/UPPER)
          const best = longKeys.reduce((a, b) => b.length > a.length ? b : a);
          // Convert ALL_CAPS / UPPER_SNAKE_CASE to camelCase; leave camelCase/PascalCase alone
          let baseName;
          if (/^[A-Z][A-Z0-9_]+$/.test(best)) {
            // e.g. CONNECTIONTOKENCHARS → connectionTokenChars
            baseName = best.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
          } else {
            baseName = best.charAt(0).toLowerCase() + best.slice(1).replace(/[^a-zA-Z0-9]/g, '');
          }
          return { name: `${baseName}Mod`, score: 4 };
        }
      }

      // Symbol.for('key') — named shared symbol (score 9 — very reliable)
      if (callee?.type === 'MemberExpression' &&
          callee.object?.name === 'Symbol' &&
          callee.property?.name === 'for') {
        const key = args?.[0]?.value;
        if (typeof key === 'string') return { name: symbolKeyToName(key), score: 9 };
        return { name: 'namedSym', score: 7 };
      }

      // Symbol() — always a unique key/id
      if (callee?.name === 'Symbol') {
        const label = args?.[0]?.value;
        return label
          ? { name: `sym_${toIdentifier(String(label)).slice(0,20)}`, score: 9 }
          : { name: 'symbolKey', score: 8 };
      }

      // Global constructors via call: Map(), Set() fallback
      const CTOR_CALLS = new Map([
        ['Promise',9],['setTimeout',7],['setInterval',7],['clearTimeout',5],
        ['clearInterval',5],['fetch',8],['setImmediate',6],['queueMicrotask',6],
      ]);
      if (callee?.type === 'Identifier' && CTOR_CALLS.has(callee.name)) {
        const names = { Promise:'promise', setTimeout:'timer', setInterval:'intervalTimer',
                        fetch:'fetchResult', clearTimeout:'timerRef', clearInterval:'intervalRef',
                        setImmediate:'immediateHandle', queueMicrotask:'microtask' };
        return { name: names[callee.name], score: CTOR_CALLS.get(callee.name) };
      }

      // Pattern: getXxx() / fetchXxx() / createXxx() / buildXxx() / makeXxx() / openXxx()
      // Extract "Xxx" as the semantic name
      const GETTER_RE = /^(?:get|fetch|create|build|make|open|load|read|parse|resolve|find|lookup|extract|generate|init|initialize|prepare|compute|calculate)([A-Z][a-zA-Z0-9]{2,})/;
      const directName = callee?.name ?? callee?.property?.name;
      if (directName) {
        const m = directName.match(GETTER_RE);
        if (m) {
          const noun = m[1].charAt(0).toLowerCase() + m[1].slice(1);
          return { name: noun.slice(0, 28), score: 8 };
        }
      }

      // Pattern: xxx.toXxx(), xxx.asXxx()
      const CAST_RE = /^(?:to|as)([A-Z][a-zA-Z0-9]{2,})/;
      if (callee?.property?.name) {
        const mc = callee.property.name.match(CAST_RE);
        if (mc) {
          const noun = mc[1].charAt(0).toLowerCase() + mc[1].slice(1);
          return { name: noun.slice(0, 28), score: 7 };
        }
      }

      // Member expression: specific well-known factories
      if (callee?.type === 'MemberExpression') {
        const obj = callee.object?.name;
        const prop = callee.property?.name;
        const MEM_MAP = new Map([
          ['Object.create','proto'],['Object.assign','merged'],['Object.freeze','frozen'],
          ['Object.keys','keys'],['Object.values','values'],['Object.entries','entries'],
          ['Object.fromEntries','fromEntries'],['Array.from','items'],['Array.isArray','isArray'],
          ['Array.of','items'],
          ['Math.random','randomVal'],['Math.floor','floored'],['Math.ceil','ceiled'],
          ['Math.round','rounded'],['Math.trunc','truncated'],['Math.sign','sign'],
          ['Math.max','maxVal'],['Math.min','minVal'],['Math.abs','absVal'],
          ['Math.sqrt','sqrtVal'],['Math.pow','powVal'],['Math.log','logVal'],
          ['Date.now','timestamp'],['Date.parse','parsedDate'],
          ['JSON.parse','parsed'],['JSON.stringify','serialized'],
          ['Promise.all','allPromises'],['Promise.race','racePromise'],
          ['Promise.resolve','resolved'],['Promise.reject','rejected'],
          ['Promise.allSettled','settledPromises'],['Promise.any','anyPromise'],
          ['Buffer.from','buf'],['Buffer.alloc','buf'],['Buffer.concat','buf'],
          ['Buffer.isBuffer','isBuf'],
          ['crypto.randomUUID','uuid'],['crypto.createHash','hasher'],
          ['crypto.createHmac','hmac'],['crypto.randomBytes','randomBytes'],
          ['path.join','joinedPath'],['path.resolve','resolvedPath'],
          ['path.relative','relativePath'],['path.normalize','normalizedPath'],
          ['path.basename','baseName'],['path.dirname','dirName'],
          ['path.extname','extName'],['path.parse','parsedPath'],
          ['path.format','formattedPath'],
          ['fs.createReadStream','readStream'],['fs.createWriteStream','writeStream'],
          ['fs.readFileSync','fileContent'],['fs.writeFileSync','void'],
          ['fs.readdirSync','dirEntries'],['fs.statSync','fileStat'],
          ['fs.existsSync','exists'],['fs.mkdirSync','void'],
          ['url.parse','parsedUrl'],['url.format','formattedUrl'],
          ['url.resolve','resolvedUrl'],
          ['querystring.stringify','qsStr'],['querystring.parse','qsParsed'],
          ['process.nextTick','nextTickFn'],['process.hrtime','hrtime'],
          ['EventEmitter.call','emitter'],
          ['String.fromCharCode','str'],['String.fromCodePoint','str'],
          ['Number.parseInt','num'],['Number.parseFloat','num'],
          ['Number.isInteger','isInt'],['Number.isFinite','isFinite'],
          ['Number.isNaN','isNaN'],['Number.isSafeInteger','isSafeInt'],
          ['Reflect.apply','applyResult'],['Reflect.construct','obj'],
          ['Reflect.ownKeys','keys'],['Reflect.get','val'],
        ]);
        const key = `${obj}.${prop}`;
        if (MEM_MAP.has(key)) return { name: MEM_MAP.get(key), score: 8 };

        if (prop === 'bind')        return { name: 'boundFn', score: 6 };
        if (prop === 'call')        return { name: 'callResult', score: 5 };
        if (prop === 'apply')       return { name: 'applyResult', score: 5 };
        if (prop === 'map')         return { name: 'mapped', score: 5 };
        if (prop === 'flatMap')     return { name: 'flatMapped', score: 5 };
        if (prop === 'filter')      return { name: 'filtered', score: 5 };
        if (prop === 'reduce')      return { name: 'reduced', score: 5 };
        if (prop === 'reduceRight') return { name: 'reduced', score: 5 };
        if (prop === 'find')        return { name: 'found', score: 5 };
        if (prop === 'findIndex')   return { name: 'foundIdx', score: 5 };
        if (prop === 'indexOf')     return { name: 'idx', score: 4 };
        if (prop === 'lastIndexOf') return { name: 'idx', score: 4 };
        if (prop === 'slice')       return { name: 'sliced', score: 4 };
        if (prop === 'splice')      return { name: 'removed', score: 4 };
        if (prop === 'concat')      return { name: 'combined', score: 4 };
        if (prop === 'flat')        return { name: 'flattened', score: 5 };
        if (prop === 'split')       return { name: 'parts', score: 5 };
        if (prop === 'join')        return { name: 'joined', score: 5 };
        if (prop === 'replace')     return { name: 'replaced', score: 5 };
        if (prop === 'replaceAll')  return { name: 'replaced', score: 5 };
        if (prop === 'match')       return { name: 'matched', score: 5 };
        if (prop === 'matchAll')    return { name: 'matches', score: 5 };
        if (prop === 'search')      return { name: 'searchIdx', score: 5 };
        if (prop === 'trim')        return { name: 'trimmed', score: 5 };
        if (prop === 'trimStart')   return { name: 'trimmed', score: 5 };
        if (prop === 'trimEnd')     return { name: 'trimmed', score: 5 };
        if (prop === 'padStart')    return { name: 'padded', score: 4 };
        if (prop === 'padEnd')      return { name: 'padded', score: 4 };
        if (prop === 'repeat')      return { name: 'repeated', score: 4 };
        if (prop === 'sort')        return { name: 'sorted', score: 4 };
        if (prop === 'reverse')     return { name: 'reversed', score: 4 };
        if (prop === 'entries')     return { name: 'entries', score: 5 };
        if (prop === 'keys')        return { name: 'keys', score: 5 };
        if (prop === 'values')      return { name: 'values', score: 5 };
        if (prop === 'toString')    return { name: 'str', score: 4 };
        if (prop === 'valueOf')     return { name: 'val', score: 4 };
        if (prop === 'then')        return { name: 'promise', score: 6 };
        if (prop === 'catch')       return { name: 'promise', score: 5 };
        if (prop === 'finally')     return { name: 'promise', score: 5 };
        if (prop === 'toJSON')      return { name: 'json', score: 4 };
        if (prop === 'toISOString') return { name: 'isoStr', score: 6 };
        if (prop === 'toLocaleDateString') return { name: 'dateStr', score: 5 };
        if (prop === 'toFixed')     return { name: 'fixedStr', score: 5 };
        if (prop === 'toUpperCase') return { name: 'upper', score: 5 };
        if (prop === 'toLowerCase') return { name: 'lower', score: 5 };
        if (prop === 'charAt')      return { name: 'char', score: 5 };
        if (prop === 'charCodeAt')  return { name: 'charCode', score: 5 };
        if (prop === 'substring')   return { name: 'substr', score: 4 };
        if (prop === 'test')        return { name: 'matches', score: 5 };
        if (prop === 'exec')        return { name: 'regexMatch', score: 5 };
        if (prop === 'cloneNode')   return { name: 'cloned', score: 6 };
        if (prop === 'querySelector') return { name: 'el', score: 7 };
        if (prop === 'querySelectorAll') return { name: 'els', score: 7 };
        if (prop === 'getElementById') return { name: 'el', score: 7 };
        if (prop === 'createElement') return { name: 'el', score: 7 };
        if (prop === 'createTextNode') return { name: 'textNode', score: 7 };

        if (obj === 'Promise')      return { name: 'promise', score: 7 };
      }
      return null;
    }

    case 'MemberExpression': {
      // var x = obj.PROP — name from property if meaningful
      const prop = init.property?.name;
      if (!prop || init.computed) return null;
      // Uppercase first char → accessing a constructor/class/namespace from a module
      if (/^[A-Z]/.test(prop) && prop.length >= 3) {
        const base = prop.charAt(0).toLowerCase() + prop.slice(1);
        const score = HIGH_PRIO_CTORS.has(prop) ? 9 : 6;
        const name  = HIGH_PRIO_CTORS.has(prop) ? base : (prop.length >= 5 ? `${base}Ref` : `${base}Ref`);
        return { name, score };
      }
      // Well-known lowercase utility functions imported from modules
      const MEMBER_PROP_MAP = new Map([
        ['inherits','inheritsFn'],   ['extname','extName'],
        ['parse','parseFn'],         ['stringify','stringifyFn'],
        ['format','formatFn'],       ['resolve','resolveFn'],
        ['join','joinFn'],           ['basename','baseNameFn'],
        ['dirname','dirNameFn'],     ['relative','relativePathFn'],
        ['normalize','normalizeFn'], ['isAbsolute','isAbsoluteFn'],
        ['createServer','createServerFn'], ['connect','connectFn'],
        ['createConnection','createConnectionFn'],
        ['createHash','createHashFn'], ['createHmac','createHmacFn'],
        ['randomBytes','randomBytesFn'], ['randomUUID','randomUUIDFn'],
        ['readFile','readFileFn'],   ['writeFile','writeFileFn'],
        ['readFileSync','readFileSyncFn'], ['writeFileSync','writeFileSyncFn'],
        ['existsSync','existsSyncFn'], ['mkdirSync','mkdirSyncFn'],
        ['stat','statFn'],           ['statSync','statSyncFn'],
        ['readdir','readdirFn'],     ['readdirSync','readdirSyncFn'],
        ['fetch','fetchFn'],         ['send','sendFn'],
        ['emit','emitFn'],           ['on','onFn'],
        ['once','onceFn'],           ['off','offFn'],
        ['hasOwnProperty','hasPropFn'], ['getOwnPropertyNames','ownKeysFn'],
        ['getOwnPropertyDescriptor','descriptorFn'],
        ['defineProperty','definePropFn'], ['assign','assignFn'],
        ['isApiWritable','isApiWritableFn'],
        ['default','defaultExport'],
      ]);
      const sname = MEMBER_PROP_MAP.get(prop);
      if (sname) return { name: sname, score: 6 };
      return null;
    }

    case 'Identifier': {
      // var x = GLOBAL_NAME — aliasing a built-in global
      const GLOBAL_ALIAS = new Map([
        ['parseInt','parseIntFn'],   ['parseFloat','parseFloatFn'],
        ['isNaN','isNaNFn'],         ['isFinite','isFiniteFn'],
        ['encodeURIComponent','encodeURIFn'], ['decodeURIComponent','decodeURIFn'],
        ['encodeURI','encodeURIFn'], ['decodeURI','decodeURIFn'],
        ['clearTimeout','clearTimeoutFn'], ['clearInterval','clearIntervalFn'],
        ['setTimeout','setTimeoutFn'], ['setInterval','setIntervalFn'],
        ['setImmediate','setImmediateFn'], ['clearImmediate','clearImmediateFn'],
        ['queueMicrotask','queueMicrotaskFn'],
        ['Function','functionRef'], ['Object','objectRef'],
        ['Array','arrayRef'],       ['String','stringRef'],
        ['Number','numberRef'],     ['Boolean','booleanRef'],
        ['Symbol','symbolRef'],     ['BigInt','bigIntRef'],
        ['Proxy','proxyRef'],       ['Reflect','reflectRef'],
        ['Promise','promiseRef'],   ['WeakRef','weakRef'],
        ['globalThis','globalRef'], ['global','globalRef'],
        ['process','processRef'],   ['console','consoleRef'],
        ['undefined','undefinedVal'],
      ]);
      const gname = GLOBAL_ALIAS.get(init.name);
      if (gname) return { name: gname, score: 7 };
      return null;
    }

    case 'AssignmentExpression':
      // var x = y = z — recurse on the right side
      return scoreInit(init.right);

    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return { name: 'fn', score: 4 };

    case 'TemplateLiteral':
      return { name: 'tpl', score: 3 };

    case 'LogicalExpression': {
      // var x = a || b / var x = a && b / var x = a ?? b
      // Recurse on both sides and pick the higher-confidence one
      const l = scoreInit(init.left);
      const r = scoreInit(init.right);
      if (l && r) return l.score >= r.score ? l : r;
      return l ?? r ?? null;
    }

    default:
      return null;
  }
}

// ── Phase 2: Usage index (single O(n) walk) ───────────────────────────────────

const PROP_RULES = [
  // ── Arrays / iterables ──────────────────────────────────────────────────────
  ['push','array',5],['pop','array',5],['shift','array',5],['unshift','array',5],
  ['splice','array',5],['slice','array',4],['join','array',5],['sort','array',4],
  ['reverse','array',4],['flat','array',4],['flatMap','array',5],['fill','array',4],
  ['copyWithin','array',5],['findIndex','array',5],['findLast','array',4],
  ['findLastIndex','array',4],['at','array',3],['toSorted','array',4],
  ['forEach','iterable',4],['map','iterable',5],['filter','iterable',5],
  ['reduce','iterable',5],['reduceRight','iterable',5],
  ['find','iterable',4],['includes','iterable',3],
  ['some','iterable',4],['every','iterable',4],['indexOf','iterable',3],
  ['lastIndexOf','iterable',3],['values','iterable',3],
  ['length','sized',3],

  // ── Strings ──────────────────────────────────────────────────────────────────
  ['split','string',6],['trim','string',5],['trimStart','string',5],['trimEnd','string',5],
  ['replace','string',4],['replaceAll','string',5],['match','string',4],['matchAll','string',5],
  ['startsWith','string',6],['endsWith','string',6],['substring','string',5],['substr','string',5],
  ['toUpperCase','string',6],['toLowerCase','string',6],['normalize','string',5],
  ['padStart','string',6],['padEnd','string',6],['repeat','string',4],
  ['charCodeAt','string',6],['codePointAt','string',6],['charAt','string',5],
  ['indexOf','string',3],['lastIndexOf','string',3],['search','string',4],
  ['slice','string',4],['concat','string',4],

  // ── Promises ─────────────────────────────────────────────────────────────────
  ['then','promise',7],['catch','promise',7],['finally','promise',5],

  // ── Map / WeakMap ─────────────────────────────────────────────────────────────
  ['get','map',4],['set','map',4],['has','map',4],['delete','map',4],
  ['entries','map',4],['keys','map',3],['values','map',3],['size','map',4],
  ['clear','map',4],['forEach','map',3],

  // ── Set / WeakSet ─────────────────────────────────────────────────────────────
  ['add','set',5],['has','set',4],['delete','set',4],['size','set',4],

  // ── EventEmitter / DOM EventTarget ───────────────────────────────────────────
  ['on','emitter',6],['emit','emitter',7],['off','emitter',6],['once','emitter',6],
  ['removeListener','emitter',7],['addListener','emitter',7],
  ['removeAllListeners','emitter',7],['listeners','emitter',5],['listenerCount','emitter',5],
  ['addEventListener','emitter',6],['removeEventListener','emitter',6],
  ['dispatchEvent','emitter',6],

  // ── Functions ────────────────────────────────────────────────────────────────
  ['call','function',6],['apply','function',6],['bind','function',6],['name','function',3],
  ['length','function',3],['toString','function',2],

  // ── Errors ───────────────────────────────────────────────────────────────────
  ['stack','error',7],['message','error',6],['code','error',5],['cause','error',6],
  ['name','error',4],

  // ── Streams ──────────────────────────────────────────────────────────────────
  ['pipe','stream',7],['write','stream',5],['read','stream',5],['end','stream',4],
  ['resume','stream',5],['pause','stream',5],['destroy','stream',5],
  ['readable','stream',5],['writable','stream',5],['destroyed','stream',5],
  ['closed','stream',4],['cork','stream',5],['uncork','stream',5],
  ['setEncoding','stream',6],['objectMode','stream',5],['highWaterMark','stream',5],

  // ── Constructors / prototypes ────────────────────────────────────────────────
  ['prototype','ctor',7],['constructor','ctor',4],['super','ctor',4],
  ['create','ctor',5],['extend','ctor',5],['instanceof','ctor',6],
  ['subclass','ctor',5],

  // ── process ──────────────────────────────────────────────────────────────────
  ['exit','process',7],['argv','process',7],['env','process',6],
  ['cwd','process',6],['stdout','process',6],['stderr','process',6],
  ['stdin','process',6],['pid','process',6],['version','process',5],
  ['platform','process',5],['hrtime','process',5],['memoryUsage','process',5],
  ['nextTick','process',7],['kill','process',5],['on','process',4],

  // ── Parsing / serialization ───────────────────────────────────────────────────
  ['parse','parser',6],['stringify','serializer',6],['serialize','serializer',6],
  ['deserialize','parser',6],['encode','encoder',6],['decode','decoder',6],
  ['toJSON','serializer',5],['fromJSON','parser',5],

  // ── Object utils ─────────────────────────────────────────────────────────────
  ['assign','object',5],['freeze','object',5],['seal','object',5],
  ['fromEntries','object',5],['getOwnPropertyNames','object',5],
  ['getPrototypeOf','object',6],['defineProperty','object',5],
  ['getOwnPropertyDescriptor','object',5],['hasOwnProperty','object',4],
  ['is','object',3],

  // ── File system ───────────────────────────────────────────────────────────────
  ['readFile','fs',8],['writeFile','fs',8],['readFileSync','fs',8],
  ['writeFileSync','fs',8],['existsSync','fs',7],['mkdirSync','fs',7],
  ['statSync','fs',7],['readdirSync','fs',7],['unlinkSync','fs',7],
  ['appendFileSync','fs',7],['createReadStream','fs',8],['createWriteStream','fs',8],
  ['access','fs',6],['mkdir','fs',7],['readdir','fs',7],['stat','fs',6],

  // ── HTTP / network ────────────────────────────────────────────────────────────
  ['statusCode','httpResponse',7],['statusMessage','httpResponse',6],
  ['setHeader','httpMessage',7],['getHeader','httpMessage',6],['removeHeader','httpMessage',6],
  ['writeHead','httpResponse',7],['flushHeaders','httpMessage',5],
  ['socket','httpMessage',5],['connection','httpMessage',5],
  ['rawHeaders','httpMessage',6],['rawTrailers','httpMessage',5],

  // ── URL ───────────────────────────────────────────────────────────────────────
  ['pathname','url',7],['hostname','url',7],['protocol','url',7],
  ['searchParams','url',7],['href','url',6],['origin','url',6],
  ['host','url',6],['port','url',5],['hash','url',5],['username','url',5],
  ['password','url',5],

  // ── DOM elements ──────────────────────────────────────────────────────────────
  ['querySelector','element',8],['querySelectorAll','element',8],
  ['getElementById','element',8],['getElementsByClassName','element',7],
  ['getAttribute','element',7],['setAttribute','element',7],
  ['removeAttribute','element',6],['hasAttribute','element',6],
  ['appendChild','element',7],['removeChild','element',7],['replaceChild','element',7],
  ['insertBefore','element',6],['cloneNode','element',6],
  ['textContent','element',6],['innerHTML','element',6],['outerHTML','element',5],
  ['className','element',6],['classList','element',6],['style','element',5],
  ['parentNode','element',6],['parentElement','element',6],['children','element',5],
  ['firstChild','element',5],['lastChild','element',5],['nextSibling','element',5],
  ['tagName','element',6],['nodeName','element',5],['nodeType','element',4],
  ['ownerDocument','element',5],['getBoundingClientRect','element',7],
  ['offsetWidth','element',5],['offsetHeight','element',5],
  ['scrollTop','element',5],['scrollLeft','element',5],
  ['focus','element',5],['blur','element',5],['click','element',5],

  // ── Request/Response (fetch API) ──────────────────────────────────────────────
  ['json','response',7],['text','response',6],['arrayBuffer','response',7],
  ['blob','response',6],['formData','response',6],['ok','response',5],
  ['status','response',5],['headers','response',5],['body','response',5],
  ['bodyUsed','response',5],['redirected','response',5],
  ['url','request',5],['method','request',6],['mode','request',5],
  ['credentials','request',6],['cache','request',5],['redirect','request',5],
  ['referrer','request',5],['signal','request',5],['clone','response',4],

  // ── Abort controller ──────────────────────────────────────────────────────────
  ['signal','abortCtrl',7],['abort','abortCtrl',8],['aborted','abortCtrl',6],
  ['reason','abortCtrl',5],['throwIfAborted','abortCtrl',7],

  // ── Crypto ────────────────────────────────────────────────────────────────────
  ['randomUUID','crypto',8],['createHash','crypto',8],['createHmac','crypto',8],
  ['createCipher','crypto',8],['createDecipher','crypto',8],
  ['getRandomValues','crypto',7],['digest','hasher',8],['update','hasher',6],
  ['createSign','crypto',7],['createVerify','crypto',7],

  // ── Buffer / typed arrays ─────────────────────────────────────────────────────
  ['readUInt8','buffer',7],['readUInt16BE','buffer',7],['readUInt32BE','buffer',7],
  ['readInt8','buffer',7],['readInt16BE','buffer',7],['readInt32BE','buffer',7],
  ['writeUInt8','buffer',7],['writeUInt16BE','buffer',7],['writeUInt32BE','buffer',7],
  ['byteLength','buffer',6],['byteOffset','buffer',5],['buffer','buffer',5],
  ['subarray','buffer',6],['set','buffer',4],['copy','buffer',6],
  ['compare','buffer',5],['equals','buffer',5],['isBuffer','buffer',6],

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  ['readyState','websocket',7],['binaryType','websocket',6],
  ['bufferedAmount','websocket',6],['extensions','websocket',5],
  ['protocol','websocket',5],['close','websocket',5],['send','websocket',6],
  ['CONNECTING','websocket',7],['OPEN','websocket',7],
  ['CLOSING','websocket',6],['CLOSED','websocket',6],

  // ── Number / Math helpers ────────────────────────────────────────────────────
  ['toFixed','number',6],['toPrecision','number',6],['toExponential','number',6],
  ['isNaN','number',5],['isFinite','number',5],['isInteger','number',5],
  ['parseInt','number',5],['parseFloat','number',5],

  // ── Misc object shapes ────────────────────────────────────────────────────────
  ['version','versioned',5],['id','identified',3],['uid','identified',5],
  ['uuid','identified',6],['name','named',3],['type','typed',4],['kind','typed',5],
  ['tag','tagged',4],['label','labeled',4],['title','titled',4],
  ['description','described',4],['value','valued',3],['key','keyed',4],
  ['index','indexed',4],['offset','positioned',4],['position','positioned',4],
  ['line','positioned',4],['column','positioned',4],['row','positioned',4],
  ['source','sourced',4],['target','targeted',4],
  ['destination','targeted',4],['input','input',4],['output','output',4],
  ['result','result',4],['error','error',5],['success','success',5],
  ['state','state',4],['mode','mode',4],['format','format',4],
  ['encoding','encoding',5],['charset','encoding',5],
  ['data','data',3],['payload','payload',5],['event','event',4],
  ['config','config',4],['options','config',4],['settings','config',4],
  ['defaults','config',4],['args','args',4],['params','params',4],
  ['query','query',4],['schema','schema',5],['model','model',4],
  ['scope','scope',4],['context','context',4],['env','env',4],
  ['path','path',4],['dir','path',4],['file','file',4],['ext','extension',4],
  ['base','base',4],['root','root',4],['prefix','prefixed',4],
  ['pattern','pattern',5],['regexp','regex',6],
  ['timeout','timeout',5],['delay','delay',5],['interval','interval',5],
  ['retries','retries',5],['maxRetries','retries',5],['backoff','backoff',5],
  ['pending','status',4],['running','status',4],['done','status',4],
  ['enabled','flag',4],['disabled','flag',4],['active','flag',4],
  ['visible','flag',4],['hidden','flag',4],['expanded','flag',4],
  ['selected','flag',4],['checked','flag',4],

  // ── CommonJS / module ─────────────────────────────────────────────────────────
  ['exports','module',5],['require','module',5],['module','module',5],
  ['__dirname','module',6],['__filename','module',6],

  // ── React / framework refs ────────────────────────────────────────────────────
  ['current','ref',5],['ref','ref',5],
  ['useEffect','hooks',6],['useState','hooks',6],['useRef','hooks',6],
  ['useCallback','hooks',6],['useMemo','hooks',6],['useContext','hooks',6],
  ['useReducer','hooks',6],

  // ── Logger / debug ────────────────────────────────────────────────────────────
  ['debug','logger',6],['info','logger',5],['warn','logger',6],['error','logger',5],
  ['trace','logger',6],['fatal','logger',6],['log','logger',4],
  ['child','logger',6],['level','logger',5],

  // ── Iterator protocol ─────────────────────────────────────────────────────────
  ['next','iterator',6],['return','iterator',5],['throw','iterator',5],
  ['done','iterator',5],

  // ── Generator ────────────────────────────────────────────────────────────────
  ['yielded','generator',5],

  // ── Worker threads ────────────────────────────────────────────────────────────
  ['postMessage','worker',7],['terminate','worker',7],['workerData','worker',6],
  ['threadId','worker',6],['resourceLimits','worker',6],

  // ── Channels / ports ─────────────────────────────────────────────────────────
  ['port1','channel',7],['port2','channel',7],
  ['close','channel',4],

  // ── Timers ───────────────────────────────────────────────────────────────────
  ['ref','timer',5],['unref','timer',5],['refresh','timer',5],
  ['hasRef','timer',5],
];

// Build PROP_MAP with max-score deduplication: if the same property name appears
// multiple times in PROP_RULES (e.g. 'on' → emitter AND process), keep the highest score.
const PROP_MAP = new Map();
for (const [p, t, s] of PROP_RULES) {
  const existing = PROP_MAP.get(p);
  if (!existing || s > existing.score) PROP_MAP.set(p, { type: t, score: s });
}

const TYPE_NAMES = {
  array:'arr',        iterable:'list',       sized:'items',
  string:'str',       promise:'promise',
  map:'registry',     set:'pool',            emitter:'emitter',
  function:'fn',      error:'err',           stream:'stream',
  ctor:'Ctor',        process:'proc',        number:'num',
  parser:'parser',    serializer:'serializer', encoder:'encoder',
  decoder:'decoder',  object:'obj',          fs:'fsUtil',
  httpResponse:'httpResp', httpMessage:'httpMsg', url:'url',
  element:'el',       response:'resp',       request:'req',
  abortCtrl:'abortCtrl', crypto:'crypto',   buffer:'buf',
  websocket:'ws',     hasher:'hasher',
  versioned:'versioned', identified:'id',
  typed:'typed',      tagged:'tagged',       labeled:'labeled',
  titled:'titled',    described:'described', valued:'val',
  keyed:'keyed',      indexed:'indexed',     positioned:'pos',
  sourced:'src',      targeted:'target',     input:'input',
  output:'output',    result:'result',       success:'success',
  state:'state',      mode:'mode',           format:'format',
  encoding:'encoding', data:'data',          payload:'payload',
  event:'event',      config:'cfg',          args:'args',
  params:'params',    query:'query',         schema:'schema',
  model:'model',      scope:'scope',         context:'ctx',
  env:'env',          path:'filePath',       file:'file',
  extension:'ext',    base:'base',           root:'root',
  prefixed:'prefixed', pattern:'pattern',   regex:'regex',
  timeout:'timer',    delay:'delay',         interval:'intervalTimer',
  retries:'retries',  backoff:'backoff',     status:'status',
  flag:'flag',        named:'named',

  // New types
  module:'mod',       ref:'ref',             hooks:'hook',
  logger:'logger',    iterator:'iter',       generator:'gen',
  worker:'worker',    channel:'channel',     timer:'timer',
  bytes:'bytes',      blob:'blob',           date:'date',
  urlParams:'urlParams', weakMap:'weakMap',  weakSet:'weakSet',
  abortSignal:'abortSig', port:'port',       boolean:'bool',
  optional:'maybeVal', object:'obj',
  // Phase 2g types
  errClass:'ErrClass',  subClass:'SubClass', classDef:'ClassDef',
  namedSym:'sym',       symbol:'sym',
  // Class method-derived hints (v6.1)
  Connector:'Connector', Parser:'Parser',     Serializer:'Serializer',
  Validator:'Validator', Transformer:'Transformer', Compiler:'Compiler',
  Encoder:'Encoder',     Decoder:'Decoder',   Cipher:'Cipher',
  Hasher:'Hasher',       Signer:'Signer',     Verifier:'Verifier',
  Handler:'Handler',     Dispatcher:'Dispatcher', Router:'Router',
  Renderer:'Renderer',   Scheduler:'Scheduler', Migrator:'Migrator',
  Listener:'Listener',   Publisher:'Publisher', Subscriber:'Subscriber',
  Streamer:'Streamer',   Pipeline:'Pipeline',
  AuthProvider:'AuthProvider', Authorizer:'Authorizer',
  Resolver:'Resolver',   Retrier:'Retrier',   Throttler:'Throttler',
  Cache:'Cache',         Indexer:'Indexer',
};

// Event name → handler name (for fn(eventStr, minVar) patterns)
const EVENT_HANDLER_MAP = new Map([
  ['error','errorHandler'],   ['close','closeHandler'],    ['data','dataHandler'],
  ['end','endHandler'],       ['drain','drainHandler'],    ['success','successCallback'],
  ['message','messageHandler'],['connect','connectHandler'],
  ['disconnect','disconnectHandler'],['open','openHandler'],
  ['ready','readyHandler'],   ['finish','finishHandler'],  ['abort','abortHandler'],
  ['timeout','timeoutHandler'],['request','requestHandler'],
  ['response','responseHandler'],['upgrade','upgradeHandler'],
  ['listening','listenHandler'],['connection','connectionHandler'],
  ['pause','pauseHandler'],   ['resume','resumeHandler'],  ['change','changeHandler'],
  ['progress','progressHandler'],['load','loadHandler'],   ['unload','unloadHandler'],
  ['click','clickHandler'],   ['submit','submitHandler'],  ['keydown','keyHandler'],
  ['keyup','keyHandler'],     ['keypress','keyHandler'],   ['input','inputHandler'],
  ['focus','focusHandler'],   ['blur','blurHandler'],      ['scroll','scrollHandler'],
  ['resize','resizeHandler'], ['mousemove','mouseMoveHandler'],
  ['mousedown','mouseHandler'],['mouseup','mouseHandler'], ['mouseenter','mouseHandler'],
  ['mouseleave','mouseHandler'],['touchstart','touchHandler'],
  ['touchend','touchHandler'],['beforeunload','beforeUnloadHandler'],
  ['hashchange','hashChangeHandler'],['popstate','popstateHandler'],
  ['DOMContentLoaded','domReadyHandler'],['load','loadHandler'],
  ['install','installHandler'],['activate','activateHandler'],
  ['fetch','fetchHandler'],   ['push','pushHandler'],      ['sync','syncHandler'],
  ['notificationclick','notifClickHandler'],
  ['exit','exitHandler'],     ['SIGINT','sigintHandler'],  ['SIGTERM','sigtermHandler'],
  ['uncaughtException','uncaughtHandler'],['unhandledRejection','rejectionHandler'],
  ['warning','warningHandler'],['update','updateHandler'], ['delete','deleteHandler'],
  ['insert','insertHandler'], ['select','selectHandler'],  ['create','createHandler'],
  ['destroy','destroyHandler'],['start','startHandler'],   ['stop','stopHandler'],
  ['reset','resetHandler'],   ['clear','clearHandler'],
]);

// instanceof class → type hint
const INSTANCEOF_TYPE = new Map([
  ['Error','error'],['TypeError','error'],['RangeError','error'],
  ['SyntaxError','error'],['ReferenceError','error'],['URIError','error'],
  ['EvalError','error'],['AggregateError','error'],
  ['Promise','promise'],['RegExp','regex'],['Date','date'],
  ['URL','url'],['URLSearchParams','urlParams'],
  ['Map','map'],['Set','set'],['WeakMap','weakMap'],['WeakSet','weakSet'],
  ['ArrayBuffer','buffer'],['SharedArrayBuffer','buffer'],
  ['Uint8Array','bytes'],['Int8Array','bytes'],['Uint16Array','bytes'],
  ['Int16Array','bytes'],['Uint32Array','bytes'],['Int32Array','bytes'],
  ['Float32Array','bytes'],['Float64Array','bytes'],['BigInt64Array','bytes'],
  ['Buffer','buf'],['Blob','blob'],['File','file'],
  ['ReadableStream','readStream'],['WritableStream','writeStream'],
  ['TransformStream','transformStream'],
  ['EventEmitter','emitter'],['AbortController','abortCtrl'],
  ['AbortSignal','abortSignal'],
  ['Worker','worker'],['MessageChannel','channel'],['MessagePort','port'],
  ['WebSocket','websocket'],['XMLHttpRequest','xhr'],
  ['FormData','formData'],['Headers','headers'],['Request','req'],['Response','resp'],
  ['MutationObserver','observer'],['ResizeObserver','observer'],
  ['IntersectionObserver','observer'],['PerformanceObserver','observer'],
]);

// typeof value → usage type
const TYPEOF_TYPE = new Map([
  ['function','function'], ['string','string'],  ['number','number'],
  ['boolean','boolean'],   ['symbol','symbol'],   ['object','object'],
  ['undefined','optional'], ['bigint','bigint'],
]);

// Additional type names for typeof/instanceof sources
Object.assign(TYPE_NAMES, {
  optional:'opt',   boolean:'flag',   symbol:'sym',
  bigint:'bigNum',  weakMap:'weakMap', weakSet:'weakSet',
  urlParams:'urlParams', date:'date', abortSignal:'signal',
  worker:'worker',  channel:'channel', blob:'blob',
  formData:'formData', headers:'headers',
  xhr:'xhr',        observer:'observer', bytes:'bytes',
});

function buildUsageIndex(ast) {
  const index = new Map();

  function add(name, type, score) {
    if (!isMinified(name)) return;
    if (!index.has(name)) index.set(name, {});
    const s = index.get(name);
    s[type] = (s[type] ?? 0) + score;
  }

  walk.simple(ast, {
    // ── Property access + optional chain → type hints ────────────────────────
    MemberExpression(node) {
      // Optional chaining: x?.prop → x is nullable/optional
      if (node.optional && node.object?.type === 'Identifier')
        add(node.object.name, 'optional', 2);
      // PROP_MAP: x.method → type signal for x
      if (node.object?.type === 'Identifier' && node.property?.type === 'Identifier') {
        const rule = PROP_MAP.get(node.property.name);
        if (rule) add(node.object.name, rule.type, rule.score);
      }
    },

    // ── Call expression → function type ──────────────────────────────────────
    CallExpression(node) {
      if (node.callee?.type === 'Identifier') add(node.callee.name, 'function', 3);

      // Event-listener pattern: emitter.on('eventName', handlerVar)
      // or addEventListener('eventName', handlerVar) — do NOT also add eventArg
      const args = node.arguments ?? [];
      if (args[0]?.type === 'Literal' && typeof args[0].value === 'string') {
        const evName = String(args[0].value);
        if (EVENT_HANDLER_MAP.has(evName)) {
          // arg[1] (and rarely arg[2]) is the handler variable
          for (let i = 1; i < Math.min(args.length, 3); i++) {
            if (args[i]?.type === 'Identifier') add(args[i].name, `ev_${evName}`, 9);
          }
        }
      }
    },

    // ── new Xxx() → ctor type ────────────────────────────────────────────────
    NewExpression(node) {
      if (node.callee?.type === 'Identifier') add(node.callee.name, 'ctor', 5);
    },

    // ── Binary: bitwise → number; instanceof → type; typeof → type ───────────
    BinaryExpression(node) {
      // Bitwise ops → numeric
      if (['|','>>>','<<','>>','&','^'].includes(node.operator) &&
          node.left?.type === 'Identifier')
        add(node.left.name, 'number', 3);

      // Arithmetic ops → numeric (both sides)
      if (['+','-','*','/','%','**'].includes(node.operator)) {
        if (node.left?.type === 'Identifier')  add(node.left.name,  'number', 3);
        if (node.right?.type === 'Identifier') add(node.right.name, 'number', 3);
        // But '+' could also be string concat — lower score
      }

      // Comparison: x > 0, x < 100 etc. → numeric
      if (['<','>','<=','>='].includes(node.operator)) {
        if (node.left?.type === 'Identifier')  add(node.left.name,  'number', 4);
        if (node.right?.type === 'Identifier') add(node.right.name, 'number', 4);
      }

      // instanceof → strong type signal for both sides
      if (node.operator === 'instanceof') {
        const objName = node.left?.type === 'Identifier' ? node.left.name : null;
        const clsName = node.right?.name ?? node.right?.property?.name;
        if (objName && clsName) {
          const tp = INSTANCEOF_TYPE.get(clsName);
          if (tp) add(objName, tp, 8);
          // Minified class on RHS — it's a constructor, used as type check
          if (isMinified(clsName)) add(clsName, 'ctor', 4);
        }
      }

      // typeof x === 'string' / typeof x === 'function' etc.
      const [ul, ur] = [node.left, node.right];
      if (node.operator === '===' || node.operator === '==' ||
          node.operator === '!==' || node.operator === '!=') {
        // typeof guard
        const unary = ul?.type === 'UnaryExpression' ? ul
                    : ur?.type === 'UnaryExpression' ? ur : null;
        const lit   = ul?.type === 'Literal' ? ul
                    : ur?.type === 'Literal' ? ur : null;
        if (unary?.operator === 'typeof' && unary.argument?.type === 'Identifier' && lit) {
          const tp = TYPEOF_TYPE.get(String(lit.value));
          if (tp) add(unary.argument.name, tp, 7);
        }

        // x === null → nullable
        if (lit?.value === null) {
          const ident = (ul?.type === 'Identifier' ? ul : ur?.type === 'Identifier' ? ur : null);
          if (ident) add(ident.name, 'optional', 4);
        }
        // x === undefined → optional
        if (ul?.type === 'Identifier' && ur?.type === 'Identifier' && ur.name === 'undefined')
          add(ul.name, 'optional', 4);
        if (ur?.type === 'Identifier' && ul?.type === 'Identifier' && ul.name === 'undefined')
          add(ur.name, 'optional', 4);
        // x === true / x === false → boolean
        if (lit?.value === true || lit?.value === false) {
          const ident = (ul?.type === 'Identifier' ? ul : ur?.type === 'Identifier' ? ur : null);
          if (ident) add(ident.name, 'boolean', 5);
        }
        // x === 0 / x === '' → number or string
        if (typeof lit?.value === 'number') {
          const ident = (ul?.type === 'Identifier' ? ul : ur?.type === 'Identifier' ? ur : null);
          if (ident) add(ident.name, 'number', 4);
        }
        if (typeof lit?.value === 'string' && lit.value.length > 0) {
          const ident = (ul?.type === 'Identifier' ? ul : ur?.type === 'Identifier' ? ur : null);
          if (ident) add(ident.name, 'string', 3);
        }
      }
    },

    // ── Unary ops → type signals ─────────────────────────────────────────────
    UnaryExpression(node) {
      if (!node.argument) return;
      const arg = node.argument;
      // !x → boolean-ish
      if (node.operator === '!' && arg.type === 'Identifier') add(arg.name, 'boolean', 2);
      // ~x, -x, +x → numeric
      if (['~','-','+'].includes(node.operator) && arg.type === 'Identifier')
        add(arg.name, 'number', 4);
      // void x → expression result discarded (no signal)
      // delete x.prop → x is object
      if (node.operator === 'delete' && arg.type === 'MemberExpression' &&
          arg.object?.type === 'Identifier') add(arg.object.name, 'object', 3);
    },

    // ── Class extends → ctor ─────────────────────────────────────────────────
    ClassDeclaration(node) {
      if (node.superClass?.type === 'Identifier') add(node.superClass.name, 'ctor', 7);
    },
    ClassExpression(node) {
      if (node.superClass?.type === 'Identifier') add(node.superClass.name, 'ctor', 7);
    },

    // ── await x → promise ────────────────────────────────────────────────────
    AwaitExpression(node) {
      if (node.argument?.type === 'Identifier') add(node.argument.name, 'promise', 4);
      if (node.argument?.type === 'CallExpression' &&
          node.argument.callee?.type === 'Identifier')
        add(node.argument.callee.name, 'promise', 5);
    },

    // ── yield x → generator/iterable ─────────────────────────────────────────
    YieldExpression(node) {
      if (node.argument?.type === 'Identifier') add(node.argument.name, 'iterable', 3);
    },

    // ── Spread: [...x], fn(...x) → iterable/array ────────────────────────────
    SpreadElement(node) {
      if (node.argument?.type === 'Identifier') add(node.argument.name, 'array', 4);
    },

    // ── for..of → iterable ───────────────────────────────────────────────────
    ForOfStatement(node) {
      if (node.right?.type === 'Identifier') add(node.right.name, 'array', 5);
    },

    // ── for..in → object ─────────────────────────────────────────────────────
    ForInStatement(node) {
      if (node.right?.type === 'Identifier') add(node.right.name, 'object', 4);
    },

    // ── Array destructuring: const [a,b] = x → x is array ──────────────────
    VariableDeclarator(node) {
      if (node.id?.type === 'ArrayPattern' && node.init?.type === 'Identifier')
        add(node.init.name, 'array', 5);
      if (node.id?.type === 'ObjectPattern' && node.init?.type === 'Identifier')
        add(node.init.name, 'object', 4);
    },

    // ── Catch clause param → error ───────────────────────────────────────────
    // (catch(e) — e might be skip-listed if single-char, but still worth recording)
    CatchClause(node) {
      if (node.param?.type === 'Identifier') add(node.param.name, 'error', 6);
    },

    // ── Template literal: `${x}` → x is string-coercible ────────────────────
    TemplateLiteral(node) {
      for (const expr of node.expressions ?? []) {
        if (expr.type === 'Identifier') add(expr.name, 'string', 2);
      }
    },

    // ── Conditional (ternary): x ? a : b → x is boolean-ish ─────────────────
    ConditionalExpression(node) {
      if (node.test?.type === 'Identifier') add(node.test.name, 'boolean', 2);
    },

    // ── Return statements: return x → helps with function return type context
    // (handled later in return-type inference phase)

    // ── Nullish coalescing: x ?? y → optional value ──────────────────────────
    LogicalExpression(node) {
      if (node.operator === '??' && node.left?.type === 'Identifier')
        add(node.left.name, 'optional', 3);
    },

    // ── Throw x → error ──────────────────────────────────────────────────────
    ThrowStatement(node) {
      if (node.argument?.type === 'Identifier') add(node.argument.name, 'error', 5);
      if (node.argument?.type === 'NewExpression' &&
          node.argument.callee?.type === 'Identifier')
        add(node.argument.callee.name, 'ctor', 5);
    },

    // ── Switch discriminant → switch on type/status strings ──────────────────
    SwitchStatement(node) {
      if (node.discriminant?.type !== 'Identifier') return;
      const varName = node.discriminant.name;
      const caseVals = (node.cases ?? [])
        .map(c => c.test?.value)
        .filter(v => typeof v === 'string')
        .slice(0, 12);
      if (caseVals.length === 0) return;
      // Zod error codes
      const ZOD_CODES = new Set(['invalid_type','invalid_value','too_big','too_small',
        'invalid_format','not_multiple_of','unrecognized_keys','invalid_key',
        'invalid_union','invalid_element']);
      if (caseVals.some(v => ZOD_CODES.has(v)))
        add(varName, 'zodError', 8);
      // Type strings → switching on typeof result
      else if (caseVals.length >= 2 && caseVals.every(v =>
          ['string','number','boolean','object','function','symbol','undefined','bigint','null'].includes(v)))
        add(varName, 'string', 6);
      // Event names
      else if (caseVals.length >= 2 && caseVals.every(v => EVENT_HANDLER_MAP.has(v)))
        add(varName, 'eventType', 7);
      // Parser tokens (html, body, comment, text, etc.)
      else if (caseVals.some(v =>
          ['html','body','head','comment','text','space','newline','tag','attribute','doctype'].includes(v)))
        add(varName, 'parserToken', 7);
      // Status strings
      else if (caseVals.some(v =>
          ['error','success','pending','rejected','resolved','cancelled','running','idle','done'].includes(v)))
        add(varName, 'statusStr', 7);
      // HTTP methods
      else if (caseVals.some(v => ['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].includes(v)))
        add(varName, 'httpMethod', 8);
    },
  });

  // Post-process: map event-listener type strings → handler name type
  for (const [name, types] of index) {
    for (const key of Object.keys(types)) {
      if (key.startsWith('ev_')) {
        const evName = key.slice(3);
        const handlerType = EVENT_HANDLER_MAP.get(evName) ?? `${evName}Handler`;
        // Store the resolved handler name directly as a special override
        if (!index.get(name).__evHandler) index.get(name).__evHandler = handlerType;
        delete types[key]; // remove the raw ev_ key
        types['evHandler'] = (types['evHandler'] ?? 0) + 9;
      }
    }
  }

  return index;
}


// ── Shape Analysis: what properties are READ from each minified var ───────────
// Returns Map<varName, string[]> of distinct property names accessed on that var.

function buildShapeIndex(ast) {
  const shape = new Map(); // varName → Set<propName>
  walk.simple(ast, {
    MemberExpression(node) {
      if (node.object?.type !== 'Identifier') return;
      if (node.property?.type !== 'Identifier') return;
      const v = node.object.name;
      if (!isMinified(v)) return;
      const p = node.property.name;
      if (p.length < 2) return; // skip single-char noise
      if (!shape.has(v)) shape.set(v, new Set());
      shape.get(v).add(p);
    },
  });
  return shape;
}

// ── Shape → PROP_MAP aggregate scoring ────────────────────────────────────────
// For vars that don't match any SHAPE_RULE cluster, aggregate PROP_MAP scores
// across all properties accessed on that var. Handles 3,000+ vars with v.prop
// access that shape-rule matching misses (needs 3+ specific co-occurring props).

function buildPropAggScore(shapeIndex) {
  const result = new Map(); // varName → {type, score}
  for (const [varName, props] of shapeIndex) {
    const typeAcc = {}; // type → accumulated score
    for (const prop of props) {
      const hit = PROP_MAP.get(prop);
      if (!hit) continue;
      typeAcc[hit.type] = (typeAcc[hit.type] ?? 0) + hit.score;
    }
    const best = Object.entries(typeAcc).sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const [type, rawScore] = best;
    // Scale: single-prop hit at score 6 → 4, two-prop hits → 7, etc.
    const numHits = [...props].filter(p => PROP_MAP.has(p)).length;
    const finalScore = Math.min(9, numHits >= 3 ? rawScore
                               : numHits === 2 ? rawScore * 0.85
                               : rawScore * 0.65);
    if (finalScore >= 3) result.set(varName, { type, score: finalScore });
  }
  return result;
}

// Known property-cluster → semantic name mappings.
// Scored by specificity: more distinctive clusters = higher score.
const SHAPE_RULES = [
  // HTTP/networking
  { props:['method','path','headers','body'],        name:'httpRequest',      score:9 },
  { props:['method','url','headers','body'],          name:'httpRequest',      score:9 },
  { props:['statusCode','headers','body'],            name:'httpResponse',     score:9 },
  { props:['method','path','host','upgrade'],         name:'httpRequest',      score:9 },
  { props:['body','headers','contentLength'],         name:'httpMessage',      score:8 },
  { props:['host','port','pathname'],                 name:'urlInfo',          score:8 },
  { props:['hostname','port','protocol'],             name:'addressInfo',      score:8 },
  { props:['request','response'],                     name:'httpContext',       score:7 },
  { props:['request','error'],                        name:'requestContext',    score:7 },
  { props:['websocket','code','reason'],              name:'wsEvent',          score:9 },
  { props:['websocket','request'],                    name:'wsContext',         score:8 },
  { props:['socket','server'],                        name:'networkContext',    score:7 },
  { props:['address','family','port'],                name:'addressInfo',      score:8 },
  { props:['connectParams'],                          name:'connectOptions',   score:8 },
  // Auth/session
  { props:['token','refreshToken','expiresAt'],       name:'authTokens',       score:9 },
  { props:['token','expiresAt'],                      name:'authToken',         score:8 },
  { props:['userId','email','password'],              name:'userCredentials',  score:9 },
  { props:['userId','sessionId'],                     name:'sessionInfo',       score:9 },
  { props:['userId','email'],                         name:'userInfo',          score:8 },
  { props:['accessToken','scope'],                    name:'oauthToken',        score:9 },
  { props:['username','password'],                    name:'credentials',       score:9 },
  { props:['sessionId','token'],                      name:'sessionData',       score:8 },
  // CLI/commands
  { props:['command','args','flags'],                 name:'cliOptions',        score:9 },
  { props:['command','description'],                  name:'commandInfo',       score:8 },
  { props:['name','description','flags'],             name:'commandDef',        score:9 },
  { props:['name','version','description'],           name:'packageInfo',       score:8 },
  { props:['command','output'],                       name:'commandResult',     score:8 },
  // Events
  { props:['type','payload'],                         name:'eventData',         score:8 },
  { props:['type','data'],                            name:'eventData',         score:7 },
  { props:['event','handler'],                        name:'eventBinding',      score:8 },
  { props:['once','on','emit'],                       name:'emitter',           score:8 },
  { props:['on','off','emit'],                        name:'emitter',           score:8 },
  // File/path
  { props:['name','filename','contentType','encoding'], name:'fileInfo',        score:9 },
  { props:['name','filename','contentType'],          name:'fileInfo',          score:9 },
  { props:['filename','size','type'],                 name:'fileInfo',          score:9 },
  { props:['path','mode','flags'],                    name:'fileOptions',       score:8 },
  { props:['read','write','close'],                   name:'fileHandle',        score:8 },
  { props:['readFile','writeFile'],                   name:'fs',               score:8 },
  // Errors
  { props:['message','stack','code'],                 name:'errorInfo',         score:9 },
  { props:['error','message'],                        name:'errorContext',      score:8 },
  { props:['error','cause'],                          name:'errorInfo',         score:8 },
  // Config/options
  { props:['key','defaultValue','required','converter'], name:'schemaField',   score:9 },
  { props:['key','value','ttl'],                      name:'cacheEntry',        score:9 },
  { props:['key','defaultValue'],                     name:'configEntry',       score:8 },
  { props:['enabled','timeout'],                      name:'options',           score:7 },
  { props:['debug','verbose','silent'],               name:'logOptions',        score:8 },
  { props:['level','message','timestamp'],            name:'logEntry',          score:9 },
  // Forms/state
  { props:['getFormDataState','setFormDataState'],    name:'formDataCtx',       score:9 },
  { props:['value','onChange'],                       name:'fieldState',        score:8 },
  { props:['state','setState'],                       name:'stateCtx',          score:8 },
  { props:['getState','dispatch'],                    name:'store',             score:9 },
  // Generic structural hints
  { props:['start','end'],                            name:'range',             score:7 },
  { props:['start','end','step'],                     name:'range',             score:8 },
  { props:['x','y','width','height'],                 name:'rect',              score:9 },
  { props:['width','height'],                         name:'size',              score:7 },
  { props:['resolve','reject'],                       name:'deferred',          score:9 },
  { props:['subscribe','unsubscribe'],                name:'subscription',      score:9 },
  { props:['next','done','value'],                    name:'iterResult',        score:8 },
  { props:['push','pop','shift','unshift'],           name:'stack',             score:8 },
];

function nameFromShape(propsSet) {
  let best = null;
  let bestScore = 0;
  for (const rule of SHAPE_RULES) {
    const matched = rule.props.filter(p => propsSet.has(p)).length;
    if (matched === 0) continue;
    const score = rule.score * (matched / rule.props.length);
    if (score > bestScore) { bestScore = score; best = rule; }
  }
  if (!best || bestScore < 4) return null;
  return { name: best.name, score: Math.round(bestScore) };
}

// ── Destructuring Source Analysis ─────────────────────────────────────────────
// ── Namespace Signature Detection ─────────────────────────────────────────────
// Match vars whose property-access sets contain multiple keys from known
// constant-name namespaces (HTTP methods, HTML element sets, LSP types, etc.)
// These are "enum/namespace objects" bundled as a var. Score 9 when matched.

const NAMESPACE_SIGNATURES = [
  // HTTP method constants (DELETE/GET/POST/PUT/etc.)
  { name: 'httpMethods',   score: 9, required: 2,
    props: new Set(['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS','TRACE','CONNECT']) },
  // HTML tag name sets
  { name: 'htmlTags',      score: 9, required: 3,
    props: new Set(['TBODY','THEAD','TFOOT','CAPTION','COLGROUP','TABLE','TR','TD','TH','BODY','HEAD','HTML','DIV','SPAN','FORM']) },
  { name: 'htmlElems',     score: 8, required: 3,
    props: new Set(['ADDRESS','APPLET','AREA','ARTICLE','ASIDE','BASE','BASEFONT','BGSOUND','BLOCKQUOTE','CENTER','FRAME']) },
  // LSP (Language Server Protocol) request types
  { name: 'lspRequests',   score: 9, required: 2,
    props: new Set(['WorkspaceSymbolRequest','CodeActionRequest','DocumentSymbolRequest','ReferencesRequest','DefinitionRequest','SignatureHelpRequest','DocumentHighlightRequest']) },
  // LSP protocol core
  { name: 'lspProto',      score: 9, required: 2,
    props: new Set(['ProgressType','createMessageConnection','NullLogger','ConnectionOptions','ConnectionStrategy','AbstractMessageBuffer','WriteableStreamMessageWriter']) },
  // LSP notification types
  { name: 'lspNotifs',     score: 8, required: 2,
    props: new Set(['NotificationType9','NotificationType8','NotificationType7','NotificationType6','NotificationType5']) },
  // DOM error types
  { name: 'domErrors',     score: 9, required: 2,
    props: new Set(['IndexSizeError','HierarchyRequestError','WrongDocumentError','InvalidCharacterError','NotFoundError','NotSupportedError','NamespaceError']) },
  // Yoga/flexbox layout constants
  { name: 'yogaConsts',    score: 9, required: 2,
    props: new Set(['POSITION_TYPE_ABSOLUTE','POSITION_TYPE_RELATIVE','EDGE_ALL','EDGE_HORIZONTAL','EDGE_VERTICAL','EDGE_START','EDGE_END']) },
  // HTTP parser constants
  { name: 'httpParserConsts', score: 8, required: 3,
    props: new Set(['SPECIAL_HEADERS','HTAB_SP_VCHAR_OBS_TEXT','QUOTED_STRING','CONNECTION_TOKEN_CHARS','HEADER_CHARS','TOKEN','MINOR','MAJOR']) },
  // Character code constants
  { name: 'charCodes',     score: 8, required: 3,
    props: new Set(['SPACE','LINE_FEED','TABULATION','FORM_FEED','DIGIT_0','DIGIT_9','LATIN_CAPITAL_A','LATIN_CAPITAL_Z','LATIN_SMALL_A']) },
  // Semver regex parts
  { name: 'semverParts',   score: 9, required: 2,
    props: new Set(['NUMERICIDENTIFIER','NONNUMERICIDENTIFIER','MAINVERSION','MAINVERSIONLOOSE','PRERELEASEIDENTIFIER','PRERELEASEIDENTIFIERLOOSE']) },
  // Type enum (domElement/observable/array/buffer/undefined/string/number)
  { name: 'typeEnum',      score: 8, required: 3,
    props: new Set(['domElement','observable','array','buffer','undefined','string','number','nan','boolean','object','function']) },
  // HTML parse error types
  { name: 'htmlParseErrors', score: 9, required: 3,
    props: new Set(['duplicateAttribute','unexpectedNullCharacter','unexpectedQuestionMarkInsteadOfTagName','eofBeforeTagName','invalidFirstCharacterOfTagName','missingEndTagName']) },
  // DOM Node type constants (Node.ELEMENT_NODE etc.)
  { name: 'domNodeTypes',    score: 9, required: 3,
    props: new Set(['ELEMENT_NODE','ATTRIBUTE_NODE','TEXT_NODE','CDATA_SECTION_NODE','ENTITY_REFERENCE_NODE','ENTITY_NODE','PROCESSING_INSTRUCTION_NODE','COMMENT_NODE','DOCUMENT_NODE','DOCUMENT_FRAGMENT_NODE']) },
  // Semver regex named keys (semver.js internal)
  { name: 'semverRegexKeys', score: 9, required: 4,
    props: new Set(['HYPHENRANGELOOSE','HYPHENRANGE','COMPARATORTRIM','TILDETRIM','CARETTRIM','COMPARATORLOOSE','BUILD','TILDELOOSE','TILDE','CARET']) },
  // YAML AST node type constants
  { name: 'yamlNodeTypes',   score: 9, required: 4,
    props: new Set(['ALIAS','DOC','MAP','NODE_TYPE','PAIR','SCALAR','SEQ']) },
  // SQLite permission constants
  { name: 'sqliteConsts',    score: 9, required: 3,
    props: new Set(['SQLITE_READ','SQLITE_SELECT','SQLITE_FUNCTION','SQLITE_RECURSIVE','SQLITE_OK','SQLITE_PRAGMA','SQLITE_DENY','SQLITE_CREATE_TABLE','SQLITE_DROP_TABLE']) },
  // Terminal environment variable names (supports-color, chalk)
  { name: 'termEnvVars',     score: 9, required: 4,
    props: new Set(['FORCE_COLOR','TERM','CI_NAME','TEAMCITY_VERSION','COLORTERM','TERM_PROGRAM_VERSION','TERM_PROGRAM','NO_COLOR','FORCE_LEVEL']) },
  // WebSocket frame opcode constants (ws library)
  { name: 'wsOpcodes',       score: 9, required: 4,
    props: new Set(['CLOSE','PING','PONG','CONTINUATION','TEXT','BINARY']) },
  // XML/HTML/SVG namespace prefix constants
  { name: 'xmlNamespaces',   score: 9, required: 4,
    props: new Set(['XML','XLINK','XMLNS','HTML','SVG','MATHML']) },
  // Virtual DOM operation types (parse5/snabbdom pattern)
  { name: 'vdomOps',         score: 8, required: 4,
    props: new Set(['VALUE','ATTR','REMOVE_ATTR','REMOVE','INSERT','MOVE','REPLACE']) },
  // Parse5 internal constant groups
  { name: 'parse5Consts',    score: 9, required: 4,
    props: new Set(['NAMESPACES','ATTRS','DOCUMENT_MODE','TAG_NAMES','SPECIAL_ELEMENTS']) },
  // HTML serialization special strings
  { name: 'htmlSpecialStr',  score: 9, required: 3,
    props: new Set(['SCRIPT_STRING','DASH_DASH_STRING','DOCTYPE_STRING','CDATA_START_STRING','PUBLIC_STRING','SYSTEM_STRING']) },
  // LSP FileOperation notifications/requests
  { name: 'lspFileEvents',   score: 9, required: 3,
    props: new Set(['DidCreateFilesNotification','WillCreateFilesRequest','DidRenameFilesNotification','WillRenameFilesRequest','DidDeleteFilesNotification','WillDeleteFilesRequest']) },
  // LSP ProtocolRequestType / ProtocolNotificationType classes
  { name: 'lspProtoTypes',   score: 9, required: 3,
    props: new Set(['ProtocolNotificationType','ProtocolNotificationType0','ProtocolRequestType','ProtocolRequestType0','RegistrationType']) },
  // LSP SemanticTokens request types
  { name: 'lspSemTokens',    score: 9, required: 3,
    props: new Set(['SemanticTokensRefreshRequest','SemanticTokensRangeRequest','SemanticTokensDeltaRequest','SemanticTokensRequest','SemanticTokensRegistrationType']) },
  // LSP NotebookDocument sync types
  { name: 'lspNotebookDocs', score: 9, required: 3,
    props: new Set(['DidOpenNotebookDocumentNotification','DidChangeNotebookDocumentNotification','DidSaveNotebookDocumentNotification','DidCloseNotebookDocumentNotification','NotebookDocumentSyncRegistrationType']) },
  // LSP CallHierarchy request types
  { name: 'lspCallHierarchy',score: 9, required: 2,
    props: new Set(['CallHierarchyOutgoingCallsRequest','CallHierarchyIncomingCallsRequest','CallHierarchyPrepareRequest']) },
  // LSP base RPC types (RequestType, NotificationType)
  { name: 'lspRpcTypes',     score: 8, required: 3,
    props: new Set(['RequestType0','RequestType','NotificationType0','NotificationType','ProgressType']) },
];

function buildNamespaceSigIndex(shapeIndex) {
  const result = new Map(); // varName → {name, score}
  for (const [varName, props] of shapeIndex) {
    let best = null;
    for (const sig of NAMESPACE_SIGNATURES) {
      let hits = 0;
      for (const p of props) { if (sig.props.has(p)) hits++; }
      if (hits >= sig.required) {
        // Bonus: more hits = higher confidence (cap at sig.score)
        const score = Math.min(sig.score, sig.score * (hits / sig.required) * 0.9 + sig.score * 0.1);
        if (!best || score > best.score) best = { name: sig.name, score: Math.min(9, score) };
      }
    }
    if (best) result.set(varName, best);
  }
  return result;
}

// When `const { token, userId } = ab`, we know 'ab' holds those keys.
// Build an index: varName → [keyNames destructured from it]

function buildDestructIndex(ast) {
  const index = new Map(); // varName → Set<keyName>
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type !== 'ObjectPattern') return;
      if (node.init?.type !== 'Identifier') return;
      const v = node.init.name;
      if (!isMinified(v)) return;
      if (!index.has(v)) index.set(v, new Set());
      for (const prop of node.id.properties) {
        const key = prop.key?.name;
        if (key && key.length >= 3) index.get(v).add(key);
      }
    },
    // Also handle assignment destructuring: ({ token } = ab)
    AssignmentExpression(node) {
      if (node.left?.type !== 'ObjectPattern') return;
      if (node.right?.type !== 'Identifier') return;
      const v = node.right.name;
      if (!isMinified(v)) return;
      if (!index.has(v)) index.set(v, new Set());
      for (const prop of node.left.properties ?? []) {
        const key = prop.key?.name;
        if (key && key.length >= 3) index.get(v).add(key);
      }
    },
  });
  return index;
}

// Convert a set of destructured keys to a semantic name.
// Uses the same SHAPE_RULES table (the keys destructured ≈ the shape of the object).
function nameFromDestructKeys(keysSet) {
  return nameFromShape(keysSet); // same logic
}

// ── Phase 2e: Assignment aliasing / type propagation ──────────────────────────
// If `const x = y` then x and y share the same type.
// If `const x = y.prop` where prop has a known return type, x gets that type.
// Multi-pass propagation resolves transitive chains.

const ALIAS_PROP_TYPES = new Map([
  ['message',    { type:'string',    score:6 }],
  ['stack',      { type:'string',    score:7 }],
  ['code',       { type:'string',    score:5 }],
  ['name',       { type:'string',    score:4 }],
  ['length',     { type:'number',    score:6 }],
  ['size',       { type:'number',    score:5 }],
  ['status',     { type:'number',    score:5 }],
  ['statusCode', { type:'number',    score:6 }],
  ['byteLength', { type:'number',    score:6 }],
  ['body',       { type:'string',    score:5 }],
  ['data',       { type:'object',    score:4 }],
  ['headers',    { type:'object',    score:6 }],
  ['error',      { type:'error',     score:7 }],
  ['cause',      { type:'error',     score:6 }],
  ['signal',     { type:'abortCtrl', score:6 }],
  ['url',        { type:'url',       score:6 }],
  ['pathname',   { type:'string',    score:6 }],
  ['hostname',   { type:'string',    score:6 }],
  ['protocol',   { type:'string',    score:6 }],
  ['href',       { type:'string',    score:6 }],
  ['origin',     { type:'string',    score:6 }],
  ['host',       { type:'string',    score:5 }],
  ['port',       { type:'number',    score:5 }],
  ['hash',       { type:'string',    score:5 }],
  ['username',   { type:'string',    score:6 }],
  ['password',   { type:'string',    score:6 }],
  ['searchParams',{ type:'urlParams',score:7 }],
  ['env',        { type:'object',    score:5 }],
  ['argv',       { type:'array',     score:7 }],
  ['pid',        { type:'number',    score:7 }],
  ['stdout',     { type:'stream',    score:7 }],
  ['stderr',     { type:'stream',    score:7 }],
  ['stdin',      { type:'stream',    score:7 }],
  ['socket',     { type:'stream',    score:6 }],
  ['readable',   { type:'boolean',   score:5 }],
  ['writable',   { type:'boolean',   score:5 }],
  ['destroyed',  { type:'boolean',   score:5 }],
  ['closed',     { type:'boolean',   score:5 }],
  ['pending',    { type:'boolean',   score:5 }],
  ['prototype',  { type:'object',    score:6 }],
  ['constructor',{ type:'function',  score:6 }],
  ['then',       { type:'promise',   score:8 }],
  ['catch',      { type:'promise',   score:8 }],
  ['type',       { type:'string',    score:4 }],
  ['kind',       { type:'string',    score:4 }],
  ['value',      { type:'string',    score:3 }],
  ['result',     { type:'object',    score:4 }],
  ['output',     { type:'string',    score:4 }],
  ['input',      { type:'string',    score:4 }],
  ['path',       { type:'string',    score:5 }],
  ['dir',        { type:'string',    score:4 }],
  ['ext',        { type:'string',    score:4 }],
  ['base',       { type:'string',    score:4 }],
  ['prefix',     { type:'string',    score:4 }],
  ['suffix',     { type:'string',    score:4 }],
  ['encoding',   { type:'string',    score:5 }],
  ['format',     { type:'string',    score:4 }],
  ['method',     { type:'string',    score:5 }],
  ['version',    { type:'string',    score:5 }],
  ['description',{ type:'string',    score:4 }],
  ['title',      { type:'string',    score:4 }],
  ['label',      { type:'string',    score:4 }],
  ['text',       { type:'string',    score:4 }],
  ['content',    { type:'string',    score:4 }],
  ['source',     { type:'string',    score:4 }],
  ['target',     { type:'string',    score:4 }],
  ['args',       { type:'array',     score:6 }],
  ['params',     { type:'array',     score:5 }],
  ['items',      { type:'array',     score:5 }],
  ['list',       { type:'array',     score:5 }],
  ['entries',    { type:'array',     score:5 }],
  ['keys',       { type:'array',     score:5 }],
  ['values',     { type:'array',     score:5 }],
  ['children',   { type:'array',     score:5 }],
  ['results',    { type:'array',     score:5 }],
  ['errors',     { type:'array',     score:6 }],
  ['options',    { type:'object',    score:5 }],
  ['config',     { type:'object',    score:5 }],
  ['settings',   { type:'object',    score:5 }],
  ['meta',       { type:'object',    score:4 }],
  ['context',    { type:'object',    score:4 }],
  ['state',      { type:'object',    score:4 }],
  ['props',      { type:'object',    score:4 }],
  ['attributes', { type:'object',    score:5 }],
  ['scope',      { type:'object',    score:4 }],
  ['schema',     { type:'object',    score:5 }],
  ['model',      { type:'object',    score:4 }],
]);

function buildAliasIndex(ast, typedVars, funcRetTypes = new Map()) {
  // aliases: name → [{alias?, directType?, score}]
  const aliases = new Map();

  function addAlias(lhs, entry) {
    if (!aliases.has(lhs)) aliases.set(lhs, []);
    aliases.get(lhs).push(entry);
  }

  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type !== 'Identifier') return;
      const lhs = node.id.name;
      if (!isMinified(lhs)) return;

      // Direct alias: const ab = cd
      if (node.init?.type === 'Identifier') {
        addAlias(lhs, { alias: node.init.name, score: 5 });
      }

      // Property extraction: const ab = cd.prop
      if (node.init?.type === 'MemberExpression' &&
          node.init.object?.type === 'Identifier' &&
          node.init.property?.type === 'Identifier') {
        const prop = node.init.property.name;
        const rt = ALIAS_PROP_TYPES.get(prop);
        if (rt) addAlias(lhs, { directType: rt.type, score: rt.score });
        // Also propagate object type for non-literal props
        const obj = node.init.object.name;
        if (isMinified(obj)) addAlias(lhs, { alias: obj, score: 3 });
      }

      // Array element: const ab = cd[0]
      if (node.init?.type === 'MemberExpression' &&
          node.init.object?.type === 'Identifier' &&
          node.init.computed) {
        const obj = node.init.object.name;
        if (isMinified(obj)) addAlias(lhs, { alias: obj, score: 3 });
      }

      // Template literal: const ab = `...` → string
      if (node.init?.type === 'TemplateLiteral') {
        addAlias(lhs, { directType: 'string', score: 7 });
      }

      // Binary expression: const ab = x OP y
      if (node.init?.type === 'BinaryExpression') {
        const { operator: op, left, right } = node.init;
        if (['-','*','/','%','**','|','&','^','>>','>>>','<<'].includes(op)) {
          addAlias(lhs, { directType: 'number', score: 6 });
        } else if (op === '+') {
          const lStr = left?.type === 'Literal' && typeof left.value === 'string';
          const rStr = right?.type === 'Literal' && typeof right.value === 'string';
          const lTpl = left?.type === 'TemplateLiteral';
          const rTpl = right?.type === 'TemplateLiteral';
          if (lStr || rStr || lTpl || rTpl) {
            addAlias(lhs, { directType: 'string', score: 6 });
          } else {
            if (left?.type === 'Identifier' && isMinified(left.name))
              addAlias(lhs, { alias: left.name, score: 4 });
            if (right?.type === 'Identifier' && isMinified(right.name))
              addAlias(lhs, { alias: right.name, score: 4 });
          }
        } else if (['===','!==','==','!=','<','>','<=','>='].includes(op)) {
          addAlias(lhs, { directType: 'boolean', score: 6 });
          // Side-effect: operands compared to literals get typed
          const [ul, ur] = [left, right];
          if (ul?.type === 'Literal' && typeof ul.value === 'string' &&
              ur?.type === 'Identifier' && isMinified(ur.name))
            addAlias(ur.name, { directType: 'string', score: 5 });
          if (ur?.type === 'Literal' && typeof ur.value === 'string' &&
              ul?.type === 'Identifier' && isMinified(ul.name))
            addAlias(ul.name, { directType: 'string', score: 5 });
          if (ul?.type === 'Literal' && typeof ul.value === 'number' &&
              ur?.type === 'Identifier' && isMinified(ur.name))
            addAlias(ur.name, { directType: 'number', score: 5 });
          if (ur?.type === 'Literal' && typeof ur.value === 'number' &&
              ul?.type === 'Identifier' && isMinified(ul.name))
            addAlias(ul.name, { directType: 'number', score: 5 });
        }
      }

      // Unary: !x → boolean; -x/~/+ → number; typeof → string; void → optional
      if (node.init?.type === 'UnaryExpression') {
        const op = node.init.operator;
        if (op === '!') {
          addAlias(lhs, { directType: 'boolean', score: 6 });
          const arg = node.init.argument;
          if (arg?.type === 'Identifier' && isMinified(arg.name))
            addAlias(arg.name, { directType: 'boolean', score: 4 });
        } else if (op === '-' || op === '~') {
          addAlias(lhs, { directType: 'number', score: 6 });
        } else if (op === '+') {
          addAlias(lhs, { directType: 'number', score: 5 });
        } else if (op === 'typeof') {
          addAlias(lhs, { directType: 'string', score: 7 });
        } else if (op === 'void') {
          addAlias(lhs, { directType: 'optional', score: 5 });
        }
      }

      // Logical expression: const ab = a || b (propagate from typed operands)
      if (node.init?.type === 'LogicalExpression') {
        const { left, right } = node.init;
        if (left?.type === 'Identifier' && isMinified(left.name))
          addAlias(lhs, { alias: left.name, score: 4 });
        if (right?.type === 'Identifier' && isMinified(right.name))
          addAlias(lhs, { alias: right.name, score: 4 });
        if (left?.type === 'Literal' && typeof left.value === 'string')
          addAlias(lhs, { directType: 'string', score: 5 });
        if (right?.type === 'Literal' && typeof right.value === 'string')
          addAlias(lhs, { directType: 'string', score: 5 });
      }

      // Conditional assignment: const ab = x ? y : z
      if (node.init?.type === 'ConditionalExpression') {
        const { consequent: cons, alternate: alt } = node.init;
        if (cons?.type === 'Identifier' && isMinified(cons.name))
          addAlias(lhs, { alias: cons.name, score: 4 });
        if (alt?.type === 'Identifier' && isMinified(alt.name))
          addAlias(lhs, { alias: alt.name, score: 4 });
        if (cons?.type === 'Literal' && alt?.type === 'Literal') {
          if (typeof cons.value === 'string' && typeof alt.value === 'string')
            addAlias(lhs, { directType: 'string', score: 5 });
          else if (typeof cons.value === 'number' && typeof alt.value === 'number')
            addAlias(lhs, { directType: 'number', score: 5 });
          else if (typeof cons.value === 'boolean' && typeof alt.value === 'boolean')
            addAlias(lhs, { directType: 'boolean', score: 5 });
        }
        if (cons?.type === 'TemplateLiteral' || alt?.type === 'TemplateLiteral')
          addAlias(lhs, { directType: 'string', score: 5 });
        // Ternary where one branch calls a known-return-type function
        for (const branch of [cons, alt]) {
          if (branch?.type === 'CallExpression' && branch.callee?.type === 'Identifier') {
            const rt = funcRetTypes.get(branch.callee.name);
            if (rt) addAlias(lhs, { directType: rt.type, score: Math.min(rt.score, 4) });
          }
        }
      }

      // Call expression: const ab = fn(...) — use known return type
      if (node.init?.type === 'CallExpression') {
        const callee = node.init.callee;
        if (callee?.type === 'Identifier') {
          const rt = funcRetTypes.get(callee.name);
          if (rt) addAlias(lhs, { directType: rt.type, score: rt.score });

          // Oe(y) / Oe(y, true) — ESM-interop wrapper: propagate y's type/alias
          if ((callee.name === 'Oe' || callee.name === 'Ce') &&
              node.init.arguments?.[0]?.type === 'Identifier') {
            addAlias(lhs, { alias: node.init.arguments[0].name, score: 4 });
          }

          // Lazy module call: const x = rd() / cc() / fd() — propagate the lazy var's alias
          // These are S(factory)-wrapped modules; calling them returns the module exports
          if (isMinified(callee.name) && node.init.arguments?.length === 0) {
            addAlias(lhs, { alias: callee.name, score: 3 });
          }
        } else if (callee?.type === 'MemberExpression' &&
                   callee.object?.type === 'Identifier' &&
                   callee.property?.type === 'Identifier') {
          // obj.method() — use method return type from funcRetTypes if available
          const methKey = `${callee.object.name}.${callee.property.name}`;
          const rt = funcRetTypes.get(methKey) ?? funcRetTypes.get(callee.property.name);
          if (rt) addAlias(lhs, { directType: rt.type, score: Math.min(rt.score, 4) });
        }
      }
    },

    AssignmentExpression(node) {
      if (node.left?.type !== 'Identifier') return;
      const lhs = node.left.name;
      if (!isMinified(lhs)) return;

      if (node.right?.type === 'Identifier') {
        addAlias(lhs, { alias: node.right.name, score: 4 });
      }

      // ab = x ? y : z
      if (node.right?.type === 'ConditionalExpression') {
        const cons = node.right.consequent;
        const alt  = node.right.alternate;
        if (cons?.type === 'Identifier' && isMinified(cons.name))
          addAlias(lhs, { alias: cons.name, score: 3 });
        if (alt?.type === 'Identifier' && isMinified(alt.name))
          addAlias(lhs, { alias: alt.name, score: 3 });
      }

      // Property extraction: ab = cd.prop
      if (node.right?.type === 'MemberExpression' &&
          node.right.object?.type === 'Identifier' &&
          node.right.property?.type === 'Identifier') {
        const prop = node.right.property.name;
        const rt = ALIAS_PROP_TYPES.get(prop);
        if (rt) addAlias(lhs, { directType: rt.type, score: rt.score });
      }

      // Template literal assignment
      if (node.right?.type === 'TemplateLiteral')
        addAlias(lhs, { directType: 'string', score: 7 });

      // Binary arithmetic assignment
      if (node.right?.type === 'BinaryExpression') {
        const op = node.right.operator;
        if (['-','*','/','%','**','|','&','^','>>','>>>','<<'].includes(op))
          addAlias(lhs, { directType: 'number', score: 5 });
      }

      // Logical: ab = a || b
      if (node.right?.type === 'LogicalExpression') {
        const { left, right } = node.right;
        if (left?.type === 'Identifier' && isMinified(left.name))
          addAlias(lhs, { alias: left.name, score: 3 });
        if (right?.type === 'Identifier' && isMinified(right.name))
          addAlias(lhs, { alias: right.name, score: 3 });
      }

      // Call expression: ab = fn(...) — use known return type
      if (node.right?.type === 'CallExpression') {
        const callee = node.right.callee;
        if (callee?.type === 'Identifier') {
          const rt = funcRetTypes.get(callee.name);
          if (rt) addAlias(lhs, { directType: rt.type, score: rt.score });
        }
      }
    },
  });

  // Additional pass: object property SET context: `obj.prop = x` → type x from prop
  walk.simple(ast, {
    AssignmentExpression(node) {
      if (node.left?.type !== 'MemberExpression') return;
      if (node.left.property?.type !== 'Identifier') return;
      if (node.right?.type !== 'Identifier') return;
      const prop = node.left.property.name;
      const rhs  = node.right.name;
      if (!isMinified(rhs)) return;
      const rt = ALIAS_PROP_TYPES.get(prop);
      if (rt) addAlias(rhs, { directType: rt.type, score: Math.max(rt.score - 1, 3) });
    },
  });

  // Multi-pass propagation: up to 3 iterations
  const newTypes = new Map();

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const [name, links] of aliases) {
      for (const link of links) {
        // Direct type assignment from property extraction
        if (link.directType) {
          const cur = newTypes.get(name);
          if (!cur || cur.score < link.score) {
            newTypes.set(name, { type: link.directType, score: link.score });
            changed = true;
          }
        }
        // Alias propagation: forward (alias → name) and reverse (name → alias)
        if (link.alias) {
          const sourceType = typedVars.get(link.alias) ?? newTypes.get(link.alias);
          if (sourceType) {
            const effectiveScore = Math.min(link.score, sourceType.score);
            const cur = newTypes.get(name);
            if (!cur || cur.score < effectiveScore) {
              newTypes.set(name, { type: sourceType.type, score: effectiveScore });
              changed = true;
            }
          }
          // Reverse: if name is typed, propagate to alias
          if (isMinified(link.alias)) {
            const nameType = typedVars.get(name) ?? newTypes.get(name);
            if (nameType) {
              const effectiveScore = Math.min(link.score, nameType.score);
              const cur = newTypes.get(link.alias);
              if (!cur || cur.score < effectiveScore) {
                newTypes.set(link.alias, { type: nameType.type, score: effectiveScore });
                changed = true;
              }
            }
          }
        }
      }
    }
    if (!changed) break;
  }

  return newTypes;
}

// ── Phase 2d: Call-site argument typing ──────────────────────────────────────
// When a minified var is passed at a known position to a known function,
// infer the var's type from the function signature.

// Per-method argument signatures: method name → [{i, type, score}]
// Sentinel strings 'allPathSegment', 'allDisplayable', 'allNumber' mean "all args get that type"
const CALL_ARG_SIGS = new Map([
  // fs / file system
  ['readFile',     [{i:0,type:'filePath',score:9},{i:1,type:'encoding',score:7},{i:2,type:'callback',score:7}]],
  ['writeFile',    [{i:0,type:'filePath',score:9},{i:1,type:'data',score:7},{i:2,type:'callback',score:7}]],
  ['readFileSync', [{i:0,type:'filePath',score:9},{i:1,type:'encoding',score:7}]],
  ['writeFileSync',[{i:0,type:'filePath',score:9},{i:1,type:'data',score:7}]],
  ['appendFile',   [{i:0,type:'filePath',score:8},{i:1,type:'data',score:7},{i:2,type:'callback',score:7}]],
  ['unlink',       [{i:0,type:'filePath',score:8},{i:1,type:'callback',score:7}]],
  ['stat',         [{i:0,type:'filePath',score:8},{i:1,type:'callback',score:7}]],
  ['mkdir',        [{i:0,type:'filePath',score:8},{i:1,type:'callback',score:7}]],
  ['readdir',      [{i:0,type:'filePath',score:8},{i:1,type:'callback',score:7}]],
  // path module
  ['join',         'allPathSegment'],
  ['resolve',      'allPathSegment'],
  ['dirname',      [{i:0,type:'filePath',score:9}]],
  ['basename',     [{i:0,type:'filePath',score:9}]],
  ['extname',      [{i:0,type:'filePath',score:9}]],
  ['relative',     [{i:0,type:'filePath',score:8},{i:1,type:'filePath',score:8}]],
  // JSON
  ['parse',        [{i:0,type:'jsonStr',score:8}]],
  ['stringify',    [{i:0,type:'serializable',score:7}]],
  // console
  ['log',          'allDisplayable'],
  ['warn',         'allDisplayable'],
  ['error',        'allDisplayable'],
  ['info',         'allDisplayable'],
  ['debug',        'allDisplayable'],
  // timers
  ['setTimeout',   [{i:0,type:'timerFn',score:8},{i:1,type:'milliseconds',score:8}]],
  ['setInterval',  [{i:0,type:'intervalFn',score:8},{i:1,type:'milliseconds',score:8}]],
  ['clearTimeout', [{i:0,type:'timerId',score:8}]],
  ['clearInterval',[{i:0,type:'intervalId',score:8}]],
  // Promise static
  ['all',          [{i:0,type:'promiseArr',score:8}]],
  ['allSettled',   [{i:0,type:'promiseArr',score:7}]],
  // Object static
  ['keys',         [{i:0,type:'object',score:7}]],
  ['values',       [{i:0,type:'object',score:7}]],
  ['entries',      [{i:0,type:'object',score:7}]],
  ['assign',       [{i:0,type:'target',score:7},{i:1,type:'source',score:7}]],
  ['freeze',       [{i:0,type:'object',score:7}]],
  ['create',       [{i:0,type:'protoObj',score:7}]],
  // Array static
  ['from',         [{i:0,type:'iterable',score:7}]],
  ['isArray',      [{i:0,type:'maybeArray',score:8}]],
  // Buffer
  ['alloc',        [{i:0,type:'byteSize',score:8}]],
  // crypto
  ['createHash',   [{i:0,type:'hashAlgo',score:8}]],
  ['createHmac',   [{i:0,type:'hashAlgo',score:8}]],
  // Math
  ['max',          'allNumber'],
  ['min',          'allNumber'],
  ['floor',        [{i:0,type:'number',score:7}]],
  ['ceil',         [{i:0,type:'number',score:7}]],
  ['round',        [{i:0,type:'number',score:7}]],
  ['abs',          [{i:0,type:'number',score:7}]],
  ['pow',          [{i:0,type:'number',score:7},{i:1,type:'number',score:7}]],
  ['sqrt',         [{i:0,type:'number',score:7}]],
  // prototype
  ['call',         [{i:0,type:'thisContext',score:7}]],
  ['apply',        [{i:0,type:'thisContext',score:7},{i:1,type:'argsArr',score:7}]],
  ['bind',         [{i:0,type:'thisContext',score:7}]],
  // EventEmitter
  ['emit',         [{i:1,type:'eventData',score:7}]],
]);

// Exact "obj.method" combos — higher-confidence than method-only matching
const KNOWN_OBJ_METHODS = new Map([
  ['fs.readFile',       CALL_ARG_SIGS.get('readFile')],
  ['fs.writeFile',      CALL_ARG_SIGS.get('writeFile')],
  ['fs.readFileSync',   CALL_ARG_SIGS.get('readFileSync')],
  ['fs.writeFileSync',  CALL_ARG_SIGS.get('writeFileSync')],
  ['fs.appendFile',     CALL_ARG_SIGS.get('appendFile')],
  ['fs.unlink',         CALL_ARG_SIGS.get('unlink')],
  ['fs.stat',           CALL_ARG_SIGS.get('stat')],
  ['fs.mkdir',          CALL_ARG_SIGS.get('mkdir')],
  ['fs.readdir',        CALL_ARG_SIGS.get('readdir')],
  ['path.join',         'allPathSegment'],
  ['path.resolve',      'allPathSegment'],
  ['path.dirname',      CALL_ARG_SIGS.get('dirname')],
  ['path.basename',     CALL_ARG_SIGS.get('basename')],
  ['path.extname',      CALL_ARG_SIGS.get('extname')],
  ['path.relative',     CALL_ARG_SIGS.get('relative')],
  ['JSON.parse',        CALL_ARG_SIGS.get('parse')],
  ['JSON.stringify',    CALL_ARG_SIGS.get('stringify')],
  ['console.log',       'allDisplayable'],
  ['console.warn',      'allDisplayable'],
  ['console.error',     'allDisplayable'],
  ['console.info',      'allDisplayable'],
  ['console.debug',     'allDisplayable'],
  ['Promise.resolve',   [{i:0,type:'resolvedValue',score:7}]],
  ['Promise.reject',    [{i:0,type:'rejectionError',score:9}]],
  ['Promise.all',       CALL_ARG_SIGS.get('all')],
  ['Promise.allSettled',CALL_ARG_SIGS.get('allSettled')],
  ['Object.keys',       CALL_ARG_SIGS.get('keys')],
  ['Object.values',     CALL_ARG_SIGS.get('values')],
  ['Object.entries',    CALL_ARG_SIGS.get('entries')],
  ['Object.assign',     CALL_ARG_SIGS.get('assign')],
  ['Object.freeze',     CALL_ARG_SIGS.get('freeze')],
  ['Object.create',     CALL_ARG_SIGS.get('create')],
  ['Array.from',        CALL_ARG_SIGS.get('from')],
  ['Array.isArray',     CALL_ARG_SIGS.get('isArray')],
  ['Buffer.from',       [{i:0,type:'rawData',score:8},{i:1,type:'encoding',score:7}]],
  ['Buffer.alloc',      CALL_ARG_SIGS.get('alloc')],
  ['crypto.createHash', CALL_ARG_SIGS.get('createHash')],
  ['crypto.createHmac', CALL_ARG_SIGS.get('createHmac')],
  ['Math.max',          'allNumber'],
  ['Math.min',          'allNumber'],
  ['Math.floor',        CALL_ARG_SIGS.get('floor')],
  ['Math.ceil',         CALL_ARG_SIGS.get('ceil')],
  ['Math.round',        CALL_ARG_SIGS.get('round')],
  ['Math.abs',          CALL_ARG_SIGS.get('abs')],
  ['Math.pow',          CALL_ARG_SIGS.get('pow')],
  ['Math.sqrt',         CALL_ARG_SIGS.get('sqrt')],
]);

// Direct global call signatures (callee is a bare Identifier)
const GLOBAL_CALL_SIGS = new Map([
  ['isNaN',          [{i:0,type:'number',score:7}]],
  ['isFinite',       [{i:0,type:'number',score:7}]],
  ['parseInt',       [{i:0,type:'parseStr',score:7},{i:1,type:'radix',score:7}]],
  ['parseFloat',     [{i:0,type:'parseStr',score:7}]],
  ['String',         [{i:0,type:'stringifiable',score:6}]],
  ['Number',         [{i:0,type:'numericStr',score:6}]],
  ['Boolean',        [{i:0,type:'truthyVal',score:6}]],
  ['Error',          [{i:0,type:'errorMessage',score:8}]],
  ['TypeError',      [{i:0,type:'errorMessage',score:8}]],
  ['RangeError',     [{i:0,type:'errorMessage',score:8}]],
  ['SyntaxError',    [{i:0,type:'errorMessage',score:8}]],
  ['setTimeout',     [{i:0,type:'timerFn',score:8},{i:1,type:'milliseconds',score:8}]],
  ['setInterval',    [{i:0,type:'intervalFn',score:8},{i:1,type:'milliseconds',score:8}]],
  ['clearTimeout',   [{i:0,type:'timerId',score:8}]],
  ['clearInterval',  [{i:0,type:'intervalId',score:8}]],
  ['require',        [{i:0,type:'modulePath',score:9}]],
  ['fetch',          [{i:0,type:'url',score:8}]],
  ['structuredClone',[{i:0,type:'cloneable',score:7}]],
]);

// Additional TYPE_NAMES for call-arg types not already in the table above
Object.assign(TYPE_NAMES, {
  pathSegment:    'pathSeg',
  displayable:    'displayVal',
  timerFn:        'timerCallback',
  milliseconds:   'delayMs',
  timerId:        'timerId',
  intervalFn:     'intervalCallback',
  intervalId:     'intervalId',
  resolvedValue:  'resolvedVal',
  rejectionError: 'rejectionErr',
  promiseArr:     'promises',
  thisContext:    'thisCtx',
  argsArr:        'argsArr',
  rawData:        'rawData',
  byteSize:       'byteSize',
  hashAlgo:       'hashAlgorithm',
  parseStr:       'parseStr',
  radix:          'parseRadix',
  stringifiable:  'stringifiable',
  numericStr:     'numericStr',
  truthyVal:      'truthyVal',
  errorMessage:   'errMsg',
  jsonStr:        'jsonStr',
  serializable:   'serializable',
  maybeArray:     'maybeArr',
  modulePath:     'modulePath',
  cloneable:      'cloneable',
  protoObj:       'protoObj',
  callback:       'callback',
  filePath:       'filePath',
  // Namespace signature types
  httpMethods:    'httpMethods',
  htmlTags:       'htmlTags',
  htmlElems:      'htmlElems',
  lspRequests:    'lspRequests',
  lspProto:       'lspProto',
  lspNotifs:      'lspNotifs',
  domErrors:      'domErrors',
  yogaConsts:     'yogaConsts',
  httpParserConsts:'httpParserConsts',
  charCodes:      'charCodes',
  semverParts:    'semverParts',
  typeEnum:       'typeEnum',
  htmlParseErrors:'htmlParseErrors',
  domNodeTypes:   'domNodeTypes',
  semverRegexKeys:'semverRegexKeys',
  yamlNodeTypes:  'yamlNodeTypes',
  sqliteConsts:   'sqliteConsts',
  termEnvVars:    'termEnvVars',
  wsOpcodes:      'wsOpcodes',
  xmlNamespaces:  'xmlNamespaces',
  vdomOps:        'vdomOps',
  parse5Consts:   'parse5Consts',
  htmlSpecialStr: 'htmlSpecialStr',
  lspFileEvents:  'lspFileEvents',
  lspProtoTypes:  'lspProtoTypes',
  lspSemTokens:   'lspSemTokens',
  lspNotebookDocs:'lspNotebookDocs',
  lspCallHierarchy:'lspCallHierarchy',
  lspRpcTypes:    'lspRpcTypes',
});

function buildCallArgIndex(ast) {
  const index = new Map(); // varName → [{type, score}]

  function record(name, type, score) {
    if (!isMinified(name)) return;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push({ type, score });
  }

  function applySignature(args, sig) {
    if (!Array.isArray(sig)) return;
    for (const { i, type, score } of sig) {
      if (i < args.length && args[i]?.type === 'Identifier')
        record(args[i].name, type, score);
    }
  }

  function applyAllArgs(args, type, score) {
    for (const arg of args) {
      if (arg?.type === 'Identifier') record(arg.name, type, score);
    }
  }

  function dispatchSig(args, sig) {
    if      (sig === 'allPathSegment') applyAllArgs(args, 'pathSegment', 9);
    else if (sig === 'allDisplayable') applyAllArgs(args, 'displayable', 5);
    else if (sig === 'allNumber')      applyAllArgs(args, 'number', 7);
    else                               applySignature(args, sig);
  }

  walk.simple(ast, {
    CallExpression(node) {
      const args = node.arguments ?? [];
      if (args.length === 0) return;
      const callee = node.callee;

      // Direct global call: foo(a, b)
      if (callee.type === 'Identifier') {
        const sig = GLOBAL_CALL_SIGS.get(callee.name);
        if (sig) dispatchSig(args, sig);
        return;
      }

      if (callee.type !== 'MemberExpression') return;
      const prop = callee.property;
      if (prop?.type !== 'Identifier') return;
      const methodName = prop.name;

      // obj.method() where obj is an Identifier
      if (callee.object?.type === 'Identifier') {
        const objName = callee.object.name;
        const exactKey = `${objName}.${methodName}`;
        if (KNOWN_OBJ_METHODS.has(exactKey)) {
          dispatchSig(args, KNOWN_OBJ_METHODS.get(exactKey));
        } else if (CALL_ARG_SIGS.has(methodName)) {
          // Fuzzy fallback: any obj.readFile, obj.join, etc.
          dispatchSig(args, CALL_ARG_SIGS.get(methodName));
        }
        return;
      }

      // a.b.method() — use method name only (lower confidence already in sig)
      if (callee.object?.type === 'MemberExpression') {
        if (CALL_ARG_SIGS.has(methodName)) {
          dispatchSig(args, CALL_ARG_SIGS.get(methodName));
        }
      }
    },

    // new Error/TypeError/etc.(msg)
    NewExpression(node) {
      const args = node.arguments ?? [];
      if (args.length === 0) return;
      if (node.callee?.type === 'Identifier') {
        const sig = GLOBAL_CALL_SIGS.get(node.callee.name);
        if (sig) applySignature(args, sig);
      }
    },
  });

  return index;
}

// ── Phase 2f: Function return type inference ──────────────────────────────────
// Walk all function definitions with minified names and infer their return type
// from the dominant type of their return statements. Enables typing call sites.

function buildFuncReturnTypes(ast) {
  const retTypes = new Map(); // funcName → {type, score}

  function inferReturnType(funcNode) {
    // Accumulate return-statement type votes (don't recurse into nested functions)
    const votes = {};
    function walk_(node) {
      if (!node || typeof node !== 'object') return;
      const t = node.type;
      if (t === 'FunctionExpression' || t === 'ArrowFunctionExpression' ||
          t === 'FunctionDeclaration') return; // don't recurse into nested fns
      if (t === 'ReturnStatement') {
        const a = node.argument;
        if (!a) { votes.void = (votes.void ?? 0) + 1; return; }
        const at = a.type;
        if (at === 'Literal') {
          if (typeof a.value === 'string')  votes.string  = (votes.string  ?? 0) + 3;
          else if (typeof a.value === 'number') votes.number = (votes.number ?? 0) + 3;
          else if (typeof a.value === 'boolean') votes.boolean = (votes.boolean ?? 0) + 3;
        } else if (at === 'TemplateLiteral') {
          votes.string = (votes.string ?? 0) + 3;
        } else if (at === 'BinaryExpression') {
          const op = a.operator;
          if (['-','*','/','%','**','|','&','^','>>','>>>','<<'].includes(op))
            votes.number = (votes.number ?? 0) + 3;
          else if (op === '+')
            votes.string = (votes.string ?? 0) + 2;
        } else if (at === 'ArrayExpression') {
          votes.array = (votes.array ?? 0) + 3;
        } else if (at === 'ObjectExpression') {
          votes.object = (votes.object ?? 0) + 2;
        } else if (at === 'NewExpression') {
          const cls = a.callee?.name;
          if (cls === 'Error' || cls === 'TypeError' || cls === 'RangeError' ||
              cls === 'SyntaxError') votes.error = (votes.error ?? 0) + 4;
          else if (cls === 'Promise') votes.promise = (votes.promise ?? 0) + 4;
          else if (cls === 'Map') votes.map = (votes.map ?? 0) + 4;
          else if (cls === 'Set') votes.set = (votes.set ?? 0) + 4;
          else if (cls === 'Buffer') votes.buffer = (votes.buffer ?? 0) + 4;
          else votes.object = (votes.object ?? 0) + 2;
        } else if (at === 'UnaryExpression') {
          if (a.operator === '!' || a.operator === 'typeof')
            votes.boolean = (votes.boolean ?? 0) + 2;
          else if (['-','+','~'].includes(a.operator))
            votes.number = (votes.number ?? 0) + 3;
        }
        return;
      }
      for (const val of Object.values(node)) {
        if (Array.isArray(val)) val.forEach(walk_);
        else if (val && typeof val === 'object') walk_(val);
      }
    }
    walk_(funcNode.body ?? funcNode);
    return votes;
  }

  function processFunc(nm, fn) {
    if (!nm || !isMinified(nm)) return;
    const votes = inferReturnType(fn);
    const entries = Object.entries(votes).filter(([k]) => k !== 'void' && k !== 'other');
    if (entries.length === 0) return;
    const total = Object.values(votes).reduce((a, b) => a + b, 0);
    const usefulTotal = entries.reduce((a, b) => a + b[1], 0);
    const best = entries.sort((a, b) => b[1] - a[1])[0];
    // Require: dominant type >= 60% of useful returns AND >= 3 vote-weight
    if (best[1] / Math.max(usefulTotal, 1) >= 0.60 && best[1] >= 3) {
      retTypes.set(nm, { type: best[0], score: 5 });
    }
  }

  walk.simple(ast, {
    VariableDeclarator(node) {
      const nm = node.id?.name;
      const init = node.init;
      if (!nm || !init) return;
      if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression')
        processFunc(nm, init);
    },
    AssignmentExpression(node) {
      const nm = node.left?.type === 'Identifier' ? node.left.name : null;
      if (!nm) return;
      const rhs = node.right;
      if (rhs?.type === 'FunctionExpression' || rhs?.type === 'ArrowFunctionExpression')
        processFunc(nm, rhs);
    },
    FunctionDeclaration(node) {
      processFunc(node.id?.name, node);
    },
  });

  return retTypes;
}

function buildMathHints(rankData, positional, bindings) {
  const hints = new Map();
  for (const [name, info] of Object.entries(rankData ?? {})) {
    if (!bindings.has(name)) continue;
    const pos = positional?.[name] ?? 0;
    let bonus = 0;
    let hint  = undefined;
    if (info.rankMatch) bonus += 3;
    if (info.importance === 'critical') { bonus += 2; hint = 'critical'; }
    else if (info.importance === 'high') bonus += 1;
    if (pos > 0.9)       { bonus += 2; hint = hint ?? 'core'; }
    else if (pos > 0.75) bonus += 1;
    if (bonus > 0) hints.set(name, { bonus, hint });
  }
  return hints;
}

// ── Context extraction for LLM ────────────────────────────────────────────────

function extractContext(source, varName, lines = 10) {
  const idx = source.indexOf(varName);
  if (idx === -1) return '';
  // For minified files (long lines), use char radius instead of line counting
  const lineStart = source.lastIndexOf('\n', idx - 1) + 1;
  const lineEnd   = source.indexOf('\n', idx);
  const lineLen   = (lineEnd === -1 ? source.length : lineEnd) - lineStart;
  if (lineLen > 500) {
    // Minified: extract ±600 chars around the variable
    const radius = 600;
    return source.slice(Math.max(0, idx - radius), idx + varName.length + radius).trim();
  }
  // Normal source: walk forward by newlines
  let end = idx, count = 0;
  const start = lineStart;
  while (end < source.length && count < lines) {
    if (source[end] === '\n') count++;
    end++;
  }
  return source.slice(start, end).trim();
}

// ── Seeds loader ───────────────────────────────────────────────────────────────

export function loadSeeds(filePath) {
  try {
    return JSON.parse(_readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

// ── Core: build rename map ─────────────────────────────────────────────────────

export async function buildRenameMap(source, opts = {}) {
  const {
    llm           = !!process.env.GH_TOKEN,
    llmBatchSize  = 15,
    workers       = source.length > 200_000 && source.length < 3_000_000,
    minConfidence = 3,
    seedsFile     = null,
  } = opts;

  // Load seeds from file if provided and opts.seeds is not already a dict
  const rawSeeds = opts.seeds;
  if (seedsFile && (typeof rawSeeds !== 'object' || !rawSeeds)) {
    try {
      opts = { ...opts, seeds: JSON.parse(_readFileSync(seedsFile, 'utf8')) };
    } catch (e) {
      if (process.env.DEBUG) console.error('[seeds]', e.message);
    }
  } else if (typeof rawSeeds === 'string' && rawSeeds) {
    // opts.seeds was passed as a file path directly — load it
    try {
      opts = { ...opts, seeds: JSON.parse(_readFileSync(rawSeeds, 'utf8')) };
    } catch (e) {
      if (process.env.DEBUG) console.error('[seeds]', e.message);
    }
  }

  // Parse AST
  let ast;
  try {
    ast = acorn.parse(source, PARSE_OPTS);
  } catch {
    try {
      ast = acorn.parse(source, { ...PARSE_OPTS, sourceType: 'script' });
    } catch (e2) {
      throw new Error(`AST parse failed: ${e2.message}`);
    }
  }

  // Phase 1: declarations
  const bindings = new Map();

  function ensureBinding(name) {
    if (!bindings.has(name))
      bindings.set(name, { initName: null, initScore: 0, usageType: null, usageScore: 0 });
    return bindings.get(name);
  }

  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier') {
        const b = ensureBinding(node.id.name);
        const r = scoreInit(node.init);
        if (r && r.score > b.initScore) { b.initName = r.name; b.initScore = r.score; }
        // Track init-alias source for post-map name propagation (Phase 2.5)
        if (node.init?.type === 'Identifier' && isMinified(node.init.name)) {
          if (!b.initAliasSrc) b.initAliasSrc = node.init.name;
        }      } else if (node.id?.type === 'ObjectPattern') {
        // const { key: aliasName } = source — register the alias binding with key as name hint
        for (const prop of (node.id.properties ?? [])) {
          if (prop.type !== 'Property') continue;
          if (prop.value?.type !== 'Identifier') continue;
          const alias = prop.value.name;
          if (!isMinified(alias)) continue;
          const key = prop.key?.name ?? prop.key?.value;
          if (!key || typeof key !== 'string' || key.length < 4) continue;
          // Skip overly generic keys that carry no semantic weight
          if (/^(key|val|data|type|name|node|next|prev|self|this|base|init|temp|item|list|args|opts|prop|attr|spec|info|meta|elem|root|head|tail|body|text|code|size|flag|mode|kind|path|file|part|rest|all|any|max|min|set|get|add|has|map)$/.test(key)) continue;
          const b = ensureBinding(alias);
          // Score 7: destructured key name is reliable semantic hint
          if (7 > b.initScore) { b.initName = key; b.initScore = 7; }
        }
      }
    },
    AssignmentExpression(node) {
      if (node.left?.type !== 'Identifier') return;
      const b = ensureBinding(node.left.name);
      const r = scoreInit(node.right);
      if (r && r.score > b.initScore) { b.initName = r.name; b.initScore = r.score; }
    },
    FunctionDeclaration(node) {
      node.params?.forEach(p => {
        if (p.type === 'Identifier') ensureBinding(p.name);
        else if (p.type === 'RestElement' && p.argument?.type === 'Identifier') {
          const b = ensureBinding(p.argument.name);
          // Rest param is always an array
          if (8 > b.initScore) { b.initName = 'arr'; b.initScore = 8; }
        } else if (p.type === 'AssignmentPattern' && p.left?.type === 'Identifier') {
          ensureBinding(p.left.name);
        }
      });
    },
    ArrowFunctionExpression(node) {
      node.params?.forEach(p => {
        if (p.type === 'Identifier') ensureBinding(p.name);
        else if (p.type === 'RestElement' && p.argument?.type === 'Identifier') {
          const b = ensureBinding(p.argument.name);
          if (8 > b.initScore) { b.initName = 'arr'; b.initScore = 8; }
        } else if (p.type === 'AssignmentPattern' && p.left?.type === 'Identifier') {
          ensureBinding(p.left.name);
        }
      });
    },
    FunctionExpression(node) {
      node.params?.forEach(p => {
        if (p.type === 'Identifier') ensureBinding(p.name);
        else if (p.type === 'RestElement' && p.argument?.type === 'Identifier') {
          const b = ensureBinding(p.argument.name);
          if (8 > b.initScore) { b.initName = 'arr'; b.initScore = 8; }
        } else if (p.type === 'AssignmentPattern' && p.left?.type === 'Identifier') {
          ensureBinding(p.left.name);
        }
      });
    },
    // Catch clause: the caught exception is always an error
    CatchClause(node) {
      if (node.param?.type === 'Identifier') {
        const b = ensureBinding(node.param.name);
        // Mark as error at high confidence (caught exceptions are errors)
        if (9 > b.initScore) { b.initName = 'err'; b.initScore = 9; }
      }
    },
    // Class declarations — capture class name as a constructor binding
    ClassDeclaration(node) {
      if (node.id?.type !== 'Identifier') return;
      const b = ensureBinding(node.id.name);
      const superName = node.superClass?.name;
      const ERROR_BASES = new Set(['Error','TypeError','RangeError','SyntaxError',
        'ReferenceError','URIError','EvalError','AggregateError']);

      // Infer purpose from method names (e.g. connect/parse/emit → Connector/Parser/Emitter)
      const CLASS_METHOD_HINTS = new Map([
        ['connect','Connector'],   ['parse','Parser'],      ['serialize','Serializer'],
        ['validate','Validator'],  ['transform','Transformer'],['compile','Compiler'],
        ['encode','Encoder'],      ['decode','Decoder'],    ['encrypt','Cipher'],
        ['decrypt','Cipher'],      ['hash','Hasher'],       ['sign','Signer'],
        ['verify','Verifier'],     ['handle','Handler'],    ['dispatch','Dispatcher'],
        ['route','Router'],        ['render','Renderer'],   ['schedule','Scheduler'],
        ['migrate','Migrator'],    ['listen','Listener'],   ['publish','Publisher'],
        ['subscribe','Subscriber'],['stream','Streamer'],   ['pipeline','Pipeline'],
        ['authenticate','AuthProvider'],['authorize','Authorizer'],
        ['resolve','Resolver'],    ['reject','Rejector'],   ['retry','Retrier'],
        ['throttle','Throttler'],  ['cache','Cache'],       ['index','Indexer'],
      ]);
      const methods = node.body?.body
        ?.filter(m => m.type === 'MethodDefinition' && m.key?.type === 'Identifier')
        .map(m => m.key.name) ?? [];
      let classHint = null;
      for (const method of methods) {
        if (CLASS_METHOD_HINTS.has(method)) { classHint = CLASS_METHOD_HINTS.get(method); break; }
      }

      // Error subclass: class Xcn extends Error { ... }
      if (superName && ERROR_BASES.has(superName)) {
        if (9 > b.initScore) { b.initName = 'errClass'; b.initScore = 9; }
      } else if (classHint) {
        // Semantically rich class (has connect/parse/handle/etc method) — use method-derived hint
        if (8 > b.initScore) { b.initName = classHint; b.initScore = 8; }
      } else if (superName) {
        // Extends some other class
        if (8 > b.initScore) { b.initName = 'subClass'; b.initScore = 8; }
      } else {
        if (7 > b.initScore) { b.initName = 'classDef'; b.initScore = 7; }
      }
      // Handle constructor params as bindings (Pattern: constructor(msg, opts) {})
      const ctor = node.body?.body?.find(m => m.type === 'MethodDefinition' && m.kind === 'constructor');
      if (ctor) {
        ctor.value?.params?.forEach(p => {
          if (p.type === 'Identifier') ensureBinding(p.name);
          else if (p.type === 'AssignmentPattern' && p.left?.type === 'Identifier')
            ensureBinding(p.left.name);
        });
      }
    },
    ImportDeclaration(node) {
      // Module source → semantic name hint for default/namespace imports
      const MODULE_HINTS = {
        path:'pathModule', 'node:path':'pathModule', 'path/posix':'pathPosix',
        fs:'fsModule', 'node:fs':'fsModule', 'node:fs/promises':'fsPromises',
        os:'osModule', 'node:os':'osModule',
        net:'netModule', 'node:net':'netModule',
        http:'httpModule', 'node:http':'httpModule',
        https:'httpsModule', 'node:https':'httpsModule',
        http2:'http2Module', 'node:http2':'http2Module',
        stream:'streamModule', 'node:stream':'streamModule',
        crypto:'cryptoModule', 'node:crypto':'cryptoModule',
        zlib:'zlibModule', 'node:zlib':'zlibModule',
        url:'urlModule', 'node:url':'urlModule',
        dns:'dnsModule', 'node:dns':'dnsModule',
        tls:'tlsModule', 'node:tls':'tlsModule',
        child_process:'childProcess', 'node:child_process':'childProcess',
        readline:'readlineModule', 'node:readline':'readlineModule',
        events:'eventsModule', 'node:events':'eventsModule',
        util:'utilModule', 'node:util':'utilModule',
        assert:'assertModule', 'node:assert':'assertModule',
        buffer:'bufferModule', 'node:buffer':'bufferModule',
        process:'processModule', 'node:process':'processModule',
        cluster:'clusterModule', 'node:cluster':'clusterModule',
        worker_threads:'workerThreads', 'node:worker_threads':'workerThreads',
        vm:'vmModule', 'node:vm':'vmModule',
        module:'moduleUtil', 'node:module':'moduleUtil',
        perf_hooks:'perfHooks', 'node:perf_hooks':'perfHooks',
        inspector:'inspectorMod', 'node:inspector':'inspectorMod',
        sqlite:'sqliteModule', 'node:sqlite':'sqliteModule',
        v8:'v8Module', 'node:v8':'v8Module',
      };
      const modName = MODULE_HINTS[node.source?.value];
      // import { key as alias } from '...' — alias bindings with key as name hint
      for (const spec of (node.specifiers ?? [])) {
        if (spec.type === 'ImportSpecifier') {
          const alias = spec.local?.name;
          const key   = spec.imported?.name ?? spec.imported?.value;
          if (!alias || !isMinified(alias)) continue;
          if (key && typeof key === 'string' && key.length >= 3 &&
              !/^(default|exports?|module|value|type|name|node|data|key|meta|spec)$/.test(key)) {
            const b = ensureBinding(alias);
            if (7 > b.initScore) { b.initName = key; b.initScore = 7; }
          } else {
            ensureBinding(alias);
          }
        } else if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
          const alias = spec.local?.name;
          if (!alias || !isMinified(alias)) continue;
          const b = ensureBinding(alias);
          if (modName && 8 > b.initScore) { b.initName = modName; b.initScore = 8; }
        }
      }
    },
  });

  // Phase 2: single-pass O(n) usage index
  const usageIndex = buildUsageIndex(ast);
  for (const [name, typeScores] of usageIndex) {
    // Filter out meta keys (__evHandler etc.) from scoring
    const scorable = Object.entries(typeScores).filter(([k]) => !k.startsWith('__'));
    const best = scorable.sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const b = bindings.get(name);
    if (b) {
      b.usageType = best[0];
      b.usageScore = best[1];
      // Store event-handler name override if present
      b.__evHandler = typeScores.__evHandler;
    }
  }

  // Phase 2b: shape index (what properties are read from each minified var)
  const shapeIndex = buildShapeIndex(ast);

  // Phase 2b-agg: aggregate PROP_MAP scoring from shape (catches 3000+ vars
  // with v.prop access that don't match any specific SHAPE_RULE cluster)
  const propAggIndex = buildPropAggScore(shapeIndex);
  let _propAggHits = 0;
  for (const [name, info] of propAggIndex) {
    const b = bindings.get(name);
    if (b && info.score > (b.propAggScore ?? 0)) {
      b.propAggType  = info.type;
      b.propAggScore = info.score;
      _propAggHits++;
    }
  }
  if (process.env.DEBUG_RECOVER) {
    console.error(`[propAgg] index=${propAggIndex.size} bindings_hit=${_propAggHits} shapeVars=${shapeIndex.size}`);
  }

  // Phase 2b-ns: namespace signature detection (HTTP methods, HTML tags, LSP types, etc.)
  // High-confidence direct initName override (score 9) for vars that ARE known constant tables.
  const namespaceSigIndex = buildNamespaceSigIndex(shapeIndex);
  let _nsSigHits = 0;
  for (const [name, info] of namespaceSigIndex) {
    const b = bindings.get(name);
    if (b && info.score > (b.initScore ?? 0)) {
      b.initName  = info.name;
      b.initScore = info.score;
      _nsSigHits++;
    }
  }
  if (process.env.DEBUG_RECOVER) {
    console.error(`[nsSig] hits=${_nsSigHits}`);
  }

  // Phase 2c: destructuring source index (what keys were extracted from each var)
  const destructIndex = buildDestructIndex(ast);

  // Phase 2e: assignment aliasing / type propagation
  // Build typedVars from ALL Phase 1+2 signals that have canonical types.
  // Run Phase 2d (callArg) first so its types are available here.
  const callArgIndex = buildCallArgIndex(ast);
  for (const [name, hints] of callArgIndex) {
    const best = hints.sort((a, b) => b.score - a.score)[0];
    const b = bindings.get(name);
    if (b && best.score > (b.callArgScore ?? 0)) {
      b.callArgType  = best.type;
      b.callArgScore = best.score;
    }
  }

  // Reverse-map initName → canonical type for propagation
  const INIT_NAME_TO_TYPE = new Map([
    ['map','map'],        ['set','set'],        ['promise','promise'],
    ['fn','function'],    ['emitter','emitter'],['timer','timeout'],
    ['buffer','buffer'],  ['arr','array'],      ['items','array'],
    ['config','object'],  ['parsed','object'],  ['merged','object'],
    ['proto','object'],   ['frozen','object'],  ['keys','array'],
    ['values','array'],   ['entries','array'],  ['str','string'],
    ['num','number'],     ['uuid','string'],    ['timestamp','number'],
    ['url','url'],        ['buf','buffer'],     ['regex','regex'],
    ['err','error'],      ['ws','websocket'],   ['stream','stream'],
    ['hasher','hasher'],  ['crypto','crypto'],  ['symbolKey','symbol'],
    ['tpl','string'],     ['mapped','array'],   ['filtered','array'],
    ['sorted','array'],   ['parts','array'],    ['joined','string'],
    ['replaced','string'],['trimmed','string'], ['sliced','array'],
    ['matched','array'],  ['reduced','object'], ['found','object'],
    ['boundFn','function'],['allPromise','promise'],['racePromise','promise'],
    ['resolved','promise'],['rejected','promise'],
    ['serialized','string'],['immediateHandle','function'],
    ['promise','promise'],['microtask','function'],
    ['fromEntries','object'],['maxVal','number'],['minVal','number'],
    ['absVal','number'],  ['floored','number'], ['ceiled','number'],
    ['randomVal','number'],['parsedDate','date'],
    ['uuid','string'],    ['readStream','stream'],['writeStream','stream'],
    ['classDef','object'],['enabled','boolean'],['disabled','boolean'],
    // Phase 2g additions
    ['errClass','error'], ['subClass','ctor'],  ['rePattern','regex'],
    ['namedSym','symbol'],
  ]);

  const typedVars = new Map();
  for (const [name, b] of bindings) {
    // usageType is the strongest runtime signal
    if (b.usageType && b.usageScore >= 4)
      typedVars.set(name, { type: b.usageType, score: b.usageScore });
    // callArgType — strong positional signal
    if (b.callArgType && b.callArgScore >= 5) {
      const cur = typedVars.get(name);
      if (!cur || cur.score < b.callArgScore)
        typedVars.set(name, { type: b.callArgType, score: b.callArgScore });
    }
    // propAggType — from property access aggregation
    if (b.propAggType && b.propAggScore >= 4) {
      const cur = typedVars.get(name);
      if (!cur || cur.score < b.propAggScore)
        typedVars.set(name, { type: b.propAggType, score: b.propAggScore });
    }
    // initName → canonical type (for alias propagation from new Map(), etc.)
    if (b.initName && b.initScore >= 5) {
      const itype = INIT_NAME_TO_TYPE.get(b.initName);
      if (itype) {
        const cur = typedVars.get(name);
        if (!cur || cur.score < b.initScore)
          typedVars.set(name, { type: itype, score: b.initScore });
      }
    }
  }

  // Phase 2f: function return type inference
  // Infer the canonical return type of each minified function, then propagate
  // to variables assigned from calling those functions.
  const funcRetTypes = buildFuncReturnTypes(ast);

  const aliasIndex = buildAliasIndex(ast, typedVars, funcRetTypes);
  for (const [name, info] of aliasIndex) {
    const b = bindings.get(name);
    if (b && info.score > (b.aliasScore ?? 0)) {
      b.aliasType  = info.type;
      b.aliasScore = info.score;
    }
  }

  // Second alias pass: seed typedVars with first-pass aliasType results,
  // enabling multi-hop transitive propagation (A→B→C where A was typed in pass 1).
  const typedVars2 = new Map(typedVars);
  // Also include funcRetTypes as typed vars for propagation
  for (const [fname, rt] of funcRetTypes) {
    const cur = typedVars2.get(fname);
    if (!cur || cur.score < rt.score)
      typedVars2.set(fname, rt);
  }
  for (const [name, b] of bindings) {
    if (b.aliasType && b.aliasScore >= 4) {
      const cur = typedVars2.get(name);
      if (!cur || cur.score < b.aliasScore)
        typedVars2.set(name, { type: b.aliasType, score: b.aliasScore });
    }
  }
  const aliasIndex2 = buildAliasIndex(ast, typedVars2, funcRetTypes);
  for (const [name, info] of aliasIndex2) {
    const b = bindings.get(name);
    if (b && info.score > (b.aliasScore ?? 0)) {
      b.aliasType  = info.type;
      b.aliasScore = info.score;
    }
  }

  // Phase 2g: Symbol.for() / class / RegExp / string-literal dedicated pass
  // This pass adds direct semantic names for patterns that Phase 1 handles via
  // scoreInit(), but for situations where the binding was not visited yet or
  // where a higher-confidence direct name should override the generic type hint.
  // Specifically handles: Symbol.for() → symbolForName, class → errClass/subClass/classDef,
  // RegExp /pattern/ → rePattern, and descriptive string literals → msgXxx names.
  {
    const PHASE2G_EXTRA_TYPES = new Map([
      ['errClass','errClass'], ['subClass','classDef'], ['classDef','classDef'],
      ['rePattern','regex'],
    ]);
    // Extend INIT_NAME_TO_TYPE for Phase 2g names
    INIT_NAME_TO_TYPE.set('errClass','error');
    INIT_NAME_TO_TYPE.set('subClass','ctor');
    INIT_NAME_TO_TYPE.set('rePattern','regex');
    INIT_NAME_TO_TYPE.set('namedSym','symbol');

    // Walk AST to pick up any Symbol.for() we might have missed in Phase 1
    // (e.g., in cases not covered by VariableDeclarator, like assignments in loops)
    walk.simple(ast, {
      AssignmentExpression(node) {
        if (node.left?.type !== 'Identifier') return;
        const { callee, arguments: args } = node.right ?? {};
        if (callee?.type === 'MemberExpression' &&
            callee.object?.name === 'Symbol' &&
            callee.property?.name === 'for' &&
            args?.[0]?.type === 'Literal' &&
            typeof args[0].value === 'string') {
          const b = bindings.get(node.left.name);
          if (b) {
            const symName = symbolKeyToName(args[0].value);
            if (9 > b.initScore) { b.initName = symName; b.initScore = 9; }
          }
        }
      },
    });
  }

  // Phase 3: parallel worker math analysis for large files
  let rankData = null, positional = null;
  if (workers) {
    try {
      const { runTasks } = await import('../workers/pool.js');
      const [rk, pos] = await runTasks(source, ['rank', 'positional'], { sourceType: 'module' });
      rankData = rk;
      positional = pos;
    } catch (e) {
      if (process.env.DEBUG) console.error('[workers]', e.message);
    }
  }

  const mathHints = buildMathHints(rankData, positional, bindings);

  // Build candidates
  const map      = {};
  const taken    = new Set();
  const uncertain = [];

  // Gap-fill LLM seed names (2026-03-12) — injected before phase scoring so they
  // register in `taken` and block collision, but CAN be overridden by higher-confidence
  // static candidates below (map[k] is only written if not already set).
  // Gap-fill seeds: loaded from external JSON file or opts.seeds dict.
  // Pass --seeds <file> to load seeds for a specific minified bundle.
  const GAP_SEEDS = opts.seeds ?? {};

  function unique(base) {
    const clean = toIdentifier(base).slice(0, 32);
    if (!taken.has(clean)) { taken.add(clean); return clean; }
    let n = 2;
    while (taken.has(`${clean}_${n}`)) n++;
    taken.add(`${clean}_${n}`);
    return `${clean}_${n}`;
  }

  for (const [mangled, b] of bindings) {
    if (!isMinified(mangled)) continue;

    let candidate  = null;
    let confidence = 0;

    // Phase 1 signal: initializer scoring
    if (b.initName && b.initScore >= 3) {
      // Use score-3 names for everything except bare numeric placeholders (N_0, N_1...)
      const useScore3 = b.initScore >= 4 || !b.initName.startsWith('N_');
      if (useScore3) {
        candidate  = b.initName;
        confidence = b.initScore;
      }
    }

    // Phase 2 signal: usage type
    if (b.usageType && b.usageScore >= 4) {
      let usageName;
      if (b.usageType === 'evHandler' && b.__evHandler) {
        // Specific event handler name (e.g. 'errorHandler', 'dataHandler')
        usageName = b.__evHandler;
      } else if (b.usageType === 'zodError') {
        usageName = 'zodIssueCode';
      } else if (b.usageType === 'eventType') {
        usageName = 'eventName';
      } else if (b.usageType === 'parserToken') {
        usageName = 'tokenType';
      } else if (b.usageType === 'statusStr') {
        usageName = 'statusValue';
      } else if (b.usageType === 'httpMethod') {
        usageName = 'httpMethod';
      } else if (b.usageType === 'eventArg') {
        usageName = null; // too noisy — skip
      } else {
        usageName = TYPE_NAMES[b.usageType] ?? b.usageType;
      }
      if (b.usageScore > confidence) {
        candidate  = usageName;
        confidence = b.usageScore;
      }
    }

    // Phase 2b signal: property shape cluster (SHAPE_RULES match)
    const shapeProps = shapeIndex.get(mangled);
    if (shapeProps && shapeProps.size >= 1) {
      const shapeResult = nameFromShape(shapeProps);
      if (shapeResult && shapeResult.score > confidence) {
        candidate  = shapeResult.name;
        confidence = shapeResult.score;
      }
    }

    // Phase 2b-agg: aggregate PROP_MAP scoring from all accessed properties
    if (b.propAggType && b.propAggScore > confidence) {
      const aggName = TYPE_NAMES[b.propAggType] ?? b.propAggType;
      if (aggName) {
        candidate  = aggName;
        confidence = b.propAggScore;
      }
    }

    // Phase 2c signal: destructuring keys extracted from this var
    const destructKeys = destructIndex.get(mangled);
    if (destructKeys && destructKeys.size >= 1) {
      const destructResult = nameFromDestructKeys(destructKeys);
      if (destructResult && destructResult.score > confidence) {
        candidate  = destructResult.name;
        confidence = destructResult.score;
      }
    }

    // Phase 2d: call-site argument typing
    if (b.callArgType && b.callArgScore >= 5) {
      const callName = TYPE_NAMES[b.callArgType] ?? b.callArgType;
      if (b.callArgScore > confidence) {
        candidate  = callName;
        confidence = b.callArgScore;
      }
    }

    // Phase 2e: assignment aliasing / type propagation
    if (b.aliasType && b.aliasScore >= 3 && b.aliasScore > confidence) {
      const aliasName = TYPE_NAMES[b.aliasType] ?? b.aliasType;
      candidate  = aliasName;
      confidence = b.aliasScore;
    }

    // Phase 3 signal: math hints from worker threads
    const hint = mathHints.get(mangled);
    if (hint) {
      confidence += hint.bonus;
      if (hint.hint === 'core' && candidate === 'fn') candidate = 'coreUtil';
    }

    if (candidate && confidence >= minConfidence && candidate !== mangled) {
      map[mangled] = unique(candidate);
    } else {
      // Check gap-seed before marking uncertain
      if (GAP_SEEDS[mangled] && !map[mangled]) {
        map[mangled] = unique(GAP_SEEDS[mangled]);
      } else {
        uncertain.push(mangled);
      }
    }
  }

  // Phase 3.5: Name-propagation alias pass
  // For each uncertain var B where B = A (Identifier alias) and A is already named,
  // propagate A's final name to B as a variant. Runs after Phase 3 so the map is complete.
  // This catches simple alias chains: const filteredResult = existingFilter → filteredResult_2
  {
    let propagated = 0;
    const stillUncertain1 = uncertain.filter(v => {
      const b = bindings.get(v);
      const src = b?.initAliasSrc;
      if (!src || map[v]) return true; // already named or no alias src
      const srcName = map[src];
      if (!srcName) return true; // source not named either
      // Propagate: give v a variant of src's name
      map[v] = unique(srcName);
      propagated++;
      return false;
    });
    if (propagated > 0 && process.env.DEBUG) {
      console.error(`[phase-3.5] name-alias propagation: +${propagated} names`);
    }
    uncertain.length = 0;
    uncertain.push(...stillUncertain1);
  }

  // Phase 4: Copilot LLM for uncertain variables
  // Auto-selects best model (Opus 4.6 preferred) and tunes batch size to its context window.
  let llmCount = 0;
  const llmMaxVars = opts.llmMaxVars ?? Infinity; // no cap by default — model limits itself

  if (llm && process.env.GH_TOKEN && uncertain.length > 0) {
    try {
      const { llmNameBatch, getActiveProfile } = await import('../llm/copilot.js');

      // Get model profile for batch sizing (Opus = 300 vars/batch, gpt-4o-mini = 40)
      const profile = await getActiveProfile();
      const batchSize = opts.llmBatchSize ?? profile.batchSize;

      // Rank uncertain vars by usage count — most-used vars first
      let prioritized = uncertain;
      if (rankData) {
        prioritized = [...uncertain].sort((a, b) => {
          const ca = rankData[a]?.count ?? 0;
          const cb = rankData[b]?.count ?? 0;
          return cb - ca;
        });
      }

      const toName = prioritized.slice(0, llmMaxVars);
      if (process.env.DEBUG) {
        console.error(`[llm] naming ${toName.length}/${uncertain.length} uncertain vars (batch=${batchSize})`);
      }

      for (let i = 0; i < toName.length; i += batchSize) {
        const batch = toName.slice(i, i + batchSize).map(name => ({
          name,
          context: extractContextMulti(source, name, 3, 500),
        }));
        try {
          const llmMap = await llmNameBatch(batch);
          for (const [mangled, semantic] of Object.entries(llmMap)) {
            if (!map[mangled] && semantic !== mangled) {
              map[mangled] = unique(semantic);
              llmCount++;
            }
          }
        } catch (e) {
          if (process.env.DEBUG) console.error(`[llm-batch-${i}]`, e.message);
        }
      }
    } catch (e) {
      if (process.env.DEBUG) console.error('[llm-import]', e.message);
    }
  }

  // Phase 5: HelixHyper graph pipeline
  // Runs AFTER static + LLM phases so it only sees truly uncertain vars.
  // Uses co-occurrence graph + community detection + influence propagation.
  let graphStats = null;
  const graph = opts.graph ?? false;

  // Update uncertain list (some may have been named by LLM above)
  const stillUncertain = uncertain.filter(v => !map[v]);

  if (graph && stillUncertain.length > 0) {
    try {
      const { graphPass } = await import('./graph.js');
      const { map: graphMap, stats: gs } = await graphPass(
        source,
        stillUncertain,
        map,  // pass already-named vars as context
        {
          llm:            llm && !!process.env.GH_TOKEN,
          propagate:      true,
          seedsPerCluster: opts.graphSeeds ?? 3,
          snapshotTag:    `jsr_${Date.now()}`,
        },
      );
      graphStats = gs;
      for (const [mangled, semantic] of Object.entries(graphMap)) {
        if (!map[mangled] && semantic && semantic !== mangled) {
          map[mangled] = unique(semantic);
        }
      }
    } catch (e) {
      if (process.env.DEBUG) console.error('[graph-pass]', e.message);
      graphStats = { error: e.message };
    }
  }

  return {
    map,
    stats: {
      static:    Object.keys(map).length - llmCount - (graphStats?.total ?? 0),
      llm:       llmCount,
      graph:     graphStats?.total ?? 0,
      total:     Object.keys(map).length,
      uncertain: stillUncertain.length,
      bindings:  bindings.size,
      graphStats,
    },
  };
}

export function applyRenameMap(source, map) {
  // Single-pass O(n) tokenizer — replaces identifiers via hash lookup.
  // Avoids O(n*m) cost of running one regex per map entry on large sources.
  const ident = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let out = '', last = 0, m;
  while ((m = ident.exec(source)) !== null) {
    out += source.slice(last, m.index);
    out += map[m[0]] ?? m[0];
    last = ident.lastIndex;
  }
  out += source.slice(last);
  return out;
}

export async function rename(source, opts = {}) {
  const { map, stats } = await buildRenameMap(source, opts);
  const code = applyRenameMap(source, map);
  return { count: stats.total, map, code, stats };
}

export async function runRename(inputPath, opts = {}) {
  const { readFileSync, writeFileSync } = await import('fs');
  const { join, basename, extname }     = await import('path');
  const { stripShebang }                = await import('../utils/source.js');
  const ora   = (await import('ora')).default;
  const chalk = (await import('chalk')).default;

  const source  = stripShebang(readFileSync(inputPath, 'utf8'));
  const useLLM  = opts.llm ?? !!process.env.GH_TOKEN;
  const sp      = ora(`Renaming${useLLM ? ' (+ Copilot LLM)' : ''}…`).start();

  const { count, map, stats } = await rename(source, { ...opts, llm: useLLM });

  const stem   = basename(inputPath, extname(inputPath));
  const outJs  = opts.output ?? join(inputPath, '..', `${stem}.renamed.js`);
  const outMap = opts.map    ?? join(inputPath, '..', `${stem}.rename-map.json`);

  writeFileSync(outJs, applyRenameMap(source, map));
  writeFileSync(outMap, JSON.stringify({ total: count, stats, map }, null, 2));

  sp.succeed(
    chalk.green(`${count} renames`) +
    chalk.dim(` [static:${stats.static} llm:${stats.llm} uncertain:${stats.uncertain}]`)
  );

  return { count, map, stats };
}
