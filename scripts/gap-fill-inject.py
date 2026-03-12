#!/usr/bin/env python3
"""
gap-fill-inject.py — Filter raw Ollama output and inject accepted seeds into renamer.js.

Usage:
  python3 scripts/gap-fill-inject.py --batches 110 111 112

Reads:
  /tmp/uncertain-batch{N}.json   — batch input (hallucination guard source)
  /tmp/gap-names-{N}.json        — raw Ollama output per batch
  /tmp/gap-names-merged.json     — accumulated accepted seeds

Writes:
  /tmp/gap-names-merged.json     — updated with new accepted seeds
  src/passes/renamer.js          — new GAP_SEEDS block appended

Filter rules (ALL must pass):
  1. key in batch_keys (hallucination guard — no invented var names)
  2. value is string
  3. 3 <= len(value) <= 60
  4. value matches ^[a-zA-Z_$][a-zA-Z0-9_$]*$  (valid JS identifier)
  5. key not already in merged (no re-seeding)
  6. value not already used (no name collision)
"""
import json, re, argparse, sys, os

RENAMER = os.path.join(os.path.dirname(__file__), '..', 'src', 'passes', 'renamer.js')
MERGED  = '/tmp/gap-names-merged.json'
VALID_IDENT = re.compile(r'^[a-zA-Z_$][a-zA-Z0-9_$]*$')

def load_merged():
    try:
        with open(MERGED) as f: return json.load(f)
    except FileNotFoundError:
        return {}

def filter_batch(B, merged):
    batch_path = f'/tmp/uncertain-batch{B}.json'
    raw_path   = f'/tmp/gap-names-{B}.json'
    if not os.path.exists(raw_path):
        print(f"B{B}: raw output missing ({raw_path}), skipping")
        return {}

    with open(batch_path) as f: batch_keys = set(v['name'] for v in json.load(f))
    with open(raw_path)   as f: raw = json.load(f)

    seen_vals = set(merged.values())
    merged_keys = set(merged.keys())
    accepted = {}

    for k, v in raw.items():
        if k not in batch_keys: continue          # hallucination guard
        if not isinstance(v, str): continue
        if len(v) < 3 or len(v) > 60: continue
        if not VALID_IDENT.match(v): continue
        if k in merged_keys: continue             # already seeded
        # Numeric suffix fallback: try v, v2, v3, ... v9 on name collision
        final_v = v
        if v in seen_vals:
            for n in range(2, 10):
                candidate = f"{v}{n}"
                if candidate not in seen_vals:
                    final_v = candidate
                    break
            else:
                continue  # all suffixes exhausted
        accepted[k] = final_v
        seen_vals.add(final_v)
        merged_keys.add(k)

    print(f"B{B}: {len(raw)} raw → {len(accepted)} accepted ({len(accepted)/max(1,len(raw))*100:.0f}%)")
    return accepted

def build_block(seeds, label):
    lines = [f"  // GAP_SEEDS: {label}"]
    for k, v in sorted(seeds.items()):
        lines.append(f"    '{k}': '{v}',")
    return '\n'.join(lines)

def inject(seeds, label, content):
    # Find last GAP_SEEDS closing `};` anchor
    pattern = re.compile(r"    '([A-Za-z0-9\$_]{2,8})': '([^']+)',\n  \};")
    matches = list(pattern.finditer(content))
    if not matches:
        print("ERROR: No GAP_SEEDS closing anchor found!", file=sys.stderr)
        return None
    last = matches[-1]
    insert_pos = last.end() - 4  # before `\n  };`
    block = '\n' + build_block(seeds, label)
    new_content = content[:insert_pos] + block + '\n' + content[insert_pos:]
    # Fix double-comma artifact
    new_content = re.sub(r"'([^']+)',,", r"'\1',", new_content)
    return new_content

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--batches', type=int, nargs='+', required=True)
    p.add_argument('--renamer', default=RENAMER)
    p.add_argument('--merged',  default=MERGED)
    args = p.parse_args()

    merged = load_merged()
    print(f"Loaded merged: {len(merged)} seeds")

    all_new = {}
    for B in args.batches:
        accepted = filter_batch(B, merged)
        all_new.update(accepted)
        merged.update(accepted)

    print(f"Total new seeds: {len(all_new)} → merged total: {len(merged)}")
    if not all_new:
        print("Nothing to inject.")
        return

    # Write merged
    with open(args.merged, 'w') as f:
        json.dump(merged, f, indent=2)
    print(f"Updated {args.merged}")

    # Inject into renamer.js
    with open(args.renamer) as f: content = f.read()
    label = f"B{min(args.batches)}-{max(args.batches)} ({len(all_new)} seeds)"
    new_content = inject(all_new, label, content)
    if new_content is None:
        sys.exit(1)
    with open(args.renamer, 'w') as f:
        f.write(new_content)
    print(f"Injected into {args.renamer}")

    # Syntax check
    ret = os.system('node --check ' + args.renamer)
    if ret == 0:
        print("✓ Syntax OK")
    else:
        print("✗ Syntax ERROR — restore from backup!", file=sys.stderr)
        sys.exit(1)

    print(f"\nNext: run benchmark:")
    print(f"  cd {os.path.dirname(args.renamer)}/../../.. && node --input-type=module -e \"")
    print(f"  import {{ buildRenameMap }} from './src/passes/renamer.js';")
    print(f"  import {{ readFileSync }} from 'fs';")
    print(f"  const r = await buildRenameMap(readFileSync('/root/copilot-src/app.stripped.js','utf8'), {{llm:false,workers:false}});")
    print(f"  const s = r.stats;")
    print(f"  console.log(s.static + '/' + s.bindings + ' = ' + (s.static/s.bindings*100).toFixed(1) + '%  uncertain:' + s.uncertain);")
    print(f"  \" 2>/dev/null")

if __name__ == '__main__':
    main()
