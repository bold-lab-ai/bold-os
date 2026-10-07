#!/usr/bin/env python3
"""
Per-turn leanings. The runs recorded each person's private answer only after rounds 3 and 6.
This asks a judge to read each person's OWN messages and say which option, if any, they leaned
towards after each message. Cached per run in eval/runs/<run>/leanings.json.

    python3 eval/leanings.py v1 --arm isolated
    python3 eval/leanings.py v7 --arm workspace
"""
import argparse, json, os, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as SV

HERE = os.path.dirname(os.path.abspath(__file__))
JUDGE_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"]
BENCH = {t["name"]: t for t in json.load(open(os.path.join(HERE, "data", "benchmark.json")))}

SYSTEM = """You read one person's messages to their assistant, in order, and say which option they leaned towards after each message. Judge only from what the person wrote: a stated choice, a clear preference, or an option they are arguing for. If they have not committed, answer null. Return JSON only: {"leanings": [<option exactly as listed, or null>, ...]} with one entry per message, in order."""


def judge(task, msgs):
    options = BENCH[task]["possible_answers"]
    user = ("Options: " + ", ".join(options) + "\n\nMessages, in order:\n"
            + "\n".join(f"{i + 1}. {m}" for i, m in enumerate(msgs)))
    _, _, d = SV.llm(SYSTEM, [SV.turn("user", user)], JUDGE_MODELS, json_mode=True, max_tokens=300,
                     check=lambda raw: json.loads(raw[raw.find("{"): raw.rfind("}") + 1]))
    out = []
    for x in (d.get("leanings") or [])[:len(msgs)]:
        s = str(x or "").strip().lower()
        hit = [o for o in options if o.lower() == s] or [o for o in options if o.lower() in s]
        out.append(hit[0] if len(hit) == 1 else None)
    return out + [None] * (len(msgs) - len(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run"); ap.add_argument("--arm", required=True); ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    path = os.path.join(HERE, "runs", a.run, "leanings.json")
    cache = json.load(open(path)) if os.path.exists(path) else {}
    rows = [r for r in (json.loads(l) for l in open(os.path.join(HERE, "runs", a.run, "results.jsonl")))
            if r.get("version") and r["arm"] == a.arm and r["key"] not in cache]

    def job(r):
        evs = [json.loads(l) for l in open(r["session"])]
        names = {e["pane"]: e["name"] for e in evs if e["type"] == "name"}
        out = {}
        for p in sorted(names):
            msgs = [e["text"] for e in evs if e["type"] == "user" and e["pane"] == p]
            try:
                out[p] = judge(r["task"], msgs)
            except Exception as e:                      # noqa: BLE001
                out[p] = [None] * len(msgs)
                SV.log(f"judge failed {r['key']} {p}: {str(e)[:80]}")
        return r["key"], {"task": r["task"], "arm": r["arm"], "seed": r["seed"], "correct": r["correct"], "names": names, "leanings": out}

    with ThreadPoolExecutor(a.workers) as ex:
        for key, val in ex.map(job, rows):
            cache[key] = val
    json.dump(cache, open(path, "w"), indent=1)
    n = sum(1 for v in cache.values() if v["arm"] == a.arm)
    print(f"{a.run} {a.arm}: leanings for {n} sessions in {path}")


if __name__ == "__main__":
    main()
