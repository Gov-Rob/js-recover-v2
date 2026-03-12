#!/usr/bin/env python3
"""
Phase 5: Graph analysis for uncertain var naming.
Builds a co-occurrence / call graph from the minified source, then uses
the names of already-mapped vars to infer names for uncertain vars.
"""
import json, re, sys, collections, os

SRC_FILE = '/root/copilot-src/app.stripped.js'
UNCERTAIN_FILE = '/tmp/uncertain-exact.json'
MERGED_FILE = '/tmp/gap-names-merged.json'
RENAMER = '/root/repos/js-recover/src/passes/renamer.js'

def load():
    src = open(SRC_FILE).read()
    uncertain_names = set(json.load(open(UNCERTAIN_FILE)))
    merged = json.load(open(MERGED_FILE))
    return src, uncertain_names, merged

def extract_module_scopes(src):
    """
    Extract module factory scopes from S((exports, module) => { ... }) 
    Returns list of (module_var, exports_var, module_body)
    """
    # Pattern: var MVAR = S((EXP, MOD) => { ... })
    pattern = re.compile(
        r'\bvar\s+([A-Za-z$_][A-Za-z0-9$_]{1,6})\s*=\s*[SR]\s*\(\s*\(\s*'
        r'([A-Za-z$_][A-Za-z0-9$_]{1,6})\s*,\s*([A-Za-z$_][A-Za-z0-9$_]{1,6})\s*\)\s*=>\s*\{'
    )
    scopes = []
    for m in pattern.finditer(src):
        mvar, exp_var, mod_var = m.group(1), m.group(2), m.group(3)
        body_start = m.end()
        scopes.append((mvar, exp_var, mod_var, body_start))
    return scopes

def build_cooccurrence_graph(src, uncertain_names, merged):
    """
    For each uncertain var, find its neighbors (vars in the same expression/statement)
    that have known names. Use neighbor names to infer the uncertain var's name.
    """
    # Tokenize into identifier tokens with positions
    ident_pat = re.compile(r'\b([A-Za-z$_][A-Za-z0-9$_]{1,8})\b')
    
    # Window-based co-occurrence: for each uncertain var, collect named neighbors in ±100 char window
    uncertain_set = {n for n in uncertain_names if n not in merged}
    named_set = set(merged.keys())
    
    # Build adjacency: uncertain -> list of (named_var, frequency)
    adj = collections.defaultdict(lambda: collections.Counter())
    
    chunk_size = 200
    for m in ident_pat.finditer(src):
        name = m.group(1)
        if name not in uncertain_set: continue
        # Look in ±100 char window
        start = max(0, m.start() - 100)
        end = min(len(src), m.end() + 100)
        chunk = src[start:end]
        for nm in ident_pat.finditer(chunk):
            neighbor = nm.group(1)
            if neighbor != name and neighbor in named_set:
                adj[name][merged[neighbor]] += 1
    
    # For each uncertain var, pick the most common neighbor name as prefix
    inferred = {}
    for uvar, counter in adj.items():
        if not counter: continue
        top_name, freq = counter.most_common(1)[0]
        # Only use if frequency ≥ 2 (appears near this var at least 2 times)
        if freq >= 2:
            # Clean top_name to make a valid prefix
            words = re.findall(r'[A-Za-z][a-z0-9]*', top_name)
            if words:
                prefix = words[0][0].lower() + words[0][1:]
                inferred[uvar] = (prefix + 'Ctx', freq, top_name)
    
    return inferred

def main():
    print("Loading source...", flush=True)
    src, uncertain_names, merged = load()
    
    uncertain_unseeded = [n for n in uncertain_names if n not in merged]
    print(f"Uncertain unseeded: {len(uncertain_unseeded)}")
    
    print("Building co-occurrence graph...", flush=True)
    inferred = build_cooccurrence_graph(src, uncertain_names, merged)
    print(f"Graph inferences: {len(inferred)}")
    
    # Filter and deduplicate
    seen_vals = set(merged.values())
    new_seeds = {}
    
    for uvar, (base_name, freq, source_name) in sorted(inferred.items(), key=lambda x: -x[1][1]):
        v = base_name
        if not re.match(r'^[a-zA-Z_$][a-zA-Z0-9_$]*$', v): continue
        if uvar in merged: continue
        for n in ([''] + list(range(2, 30))):
            c = f"{v}{n}" if n else v
            if c not in seen_vals:
                new_seeds[uvar] = c
                seen_vals.add(c)
                break
    
    print(f"New deduped seeds: {len(new_seeds)}")
    
    # Show samples
    for k, v in list(new_seeds.items())[:20]:
        src_name = inferred[k][2]
        freq = inferred[k][1]
        print(f"  {k} -> {v} (from '{src_name}' freq={freq})")
    
    with open('/tmp/graph-seeds.json', 'w') as f:
        json.dump(new_seeds, f, indent=2)
    print(f"\nSaved to /tmp/graph-seeds.json")

if __name__ == '__main__':
    main()
