#!/usr/bin/env python3
"""
gap-fill-prep.py — Prepare batch input files for Ollama gap-fill pipeline.

Usage:
  python3 scripts/gap-fill-prep.py --offset 0 --count 3 --batch-start 107

Reads:
  /tmp/uncertain-exact.json   — authoritative uncertain var list (sorted by freq)
  /tmp/gap-names-merged.json  — accumulated LLM seeds (all previously accepted names)

Writes:
  /tmp/uncertain-batch{N}.json for N in range(batch_start, batch_start+count)

Each output file contains 100 vars from the unseeded pool at the given offset.
"""
import json, argparse, os, sys

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--offset', type=int, default=0, help='Start offset into unseeded list')
    p.add_argument('--count', type=int, default=3, help='Number of batches to prep')
    p.add_argument('--batch-start', type=int, required=True, help='First batch number')
    p.add_argument('--batch-size', type=int, default=100, help='Vars per batch')
    p.add_argument('--uncertain', default='/tmp/uncertain-exact.json')
    p.add_argument('--merged', default='/tmp/gap-names-merged.json')
    args = p.parse_args()

    with open(args.uncertain) as f:
        uncertain = json.load(f)
    with open(args.merged) as f:
        merged = json.load(f)

    unseeded = [n for n in uncertain if n not in merged]
    print(f"Uncertain pool: {len(uncertain)}, merged: {len(merged)}, unseeded: {len(unseeded)}")

    for i in range(args.count):
        B = args.batch_start + i
        start = args.offset + i * args.batch_size
        end = start + args.batch_size
        batch = [{"name": n, "index": start + j} for j, n in enumerate(unseeded[start:end])]
        outfile = f'/tmp/uncertain-batch{B}.json'
        with open(outfile, 'w') as f:
            json.dump(batch, f)
        print(f"B{B}: {len(batch)} vars [{start}:{end}] → {outfile}")

    if args.count > 0:
        print(f"\nRun batches:")
        for i in range(args.count):
            B = args.batch_start + i
            print(f"  node /tmp/multi-model-batch.mjs /tmp/uncertain-batch{B}.json /tmp/gap-names-{B}.json &")
        print("  wait")

if __name__ == '__main__':
    main()
