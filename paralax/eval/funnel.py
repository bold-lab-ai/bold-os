#!/usr/bin/env python3
"""
Where does a hidden fact get lost? For every hidden fact in a run, the stages:

  said        the holder stated it to their assistant (judge)
  considered  some other person's selection step saw the holder's turn as a candidate (log)
  picked      some other person's selection step picked that turn (log), with the relation
  reached     some other person's assistant conveyed it to them (judge)
  credited    ... and named the holder (judge)
  used        a person it reached answered correctly at the end

In the isolated arm nothing can reach anyone, so any "reached" there measures judge noise.

    python3 eval/funnel.py <run> [--arm workspace] [--sessions]
"""
import argparse, json, os, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))


def load_session(path):
    if not os.path.isabs(path):
        path = os.path.join(HERE, path)
    evs = [json.loads(l) for l in open(path) if l.strip()]
    return evs


def analyse(rec):
    evs = load_session(rec["session"])
    names = {}
    for e in evs:
        if e["type"] == "name":
            names[e["pane"]] = e["name"]
    by_name = {v: k for k, v in names.items()}
    rets = [e for e in evs if e["type"] == "retrieval"]
    final = rec["answers"][str(max(int(k) for k in rec["answers"]))]
    out = []
    items = (rec.get("funnel") or {}).get("items", [])
    facts = [(h, names[p]) for p in sorted(rec["slices"]) for h in rec["slices"][p]]
    for i, (fact, holder) in enumerate(facts):
        it = next((x for x in items if x.get("fact") == i), {})
        turns = {int(t) for t in it.get("holder_turns", []) if str(t).lstrip("#").isdigit()} if it else set()
        considered = {r["pane"] for r in rets if turns & set(r.get("considered", []))}
        picked = {(r["pane"], x["relation"]) for r in rets for x in r.get("inform", []) if x["turn"] in turns}
        asked = {r["pane"] for r in rets if r.get("ask") and r["ask"]["turn"] in turns}
        reached = [n for n in it.get("reached", []) if n in by_name and n != holder]
        used = [n for n in reached if final.get(by_name[n]) == rec["correct"]]
        out.append({"fact": i, "holder": holder, "said": bool(it.get("holder_said")), "turns": sorted(turns),
                    "considered": sorted(considered), "picked": sorted(picked), "asked": sorted(asked),
                    "reached": reached, "credited": [n for n in it.get("correctly_attributed", []) if n in by_name],
                    "misattributed": [n for n in it.get("misattributed", []) if n in by_name], "used": used,
                    "holder_correct": final.get(by_name.get(holder)) == rec["correct"]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--arm", default=None)
    ap.add_argument("--sessions", action="store_true", help="print every session's facts")
    a = ap.parse_args()
    path = os.path.join(HERE, "runs", a.run, "results.jsonl")
    rows = [json.loads(l) for l in open(path) if l.strip()]
    rows = [r for r in rows if r.get("version") and r["arm"] != "full" and (not a.arm or r["arm"] == a.arm)]
    stages = defaultdict(Counter)
    rel = defaultdict(Counter)
    n_people = Counter()
    for r in rows:
        try:
            fs = analyse(r)
        except Exception as e:                        # noqa: BLE001
            print(f"skip {r['key']}: {e!r}", file=sys.stderr)
            continue
        st = stages[r["arm"]]
        for f in fs:
            st["facts"] += 1
            st["said"] += f["said"]
            st["considered"] += bool(f["considered"])
            st["picked"] += bool(f["picked"])
            st["asked"] += bool(f["asked"])
            st["reached"] += bool(f["reached"])
            st["credited"] += bool(f["credited"])
            st["misattributed"] += bool(f["misattributed"])
            st["reached_people"] += len(f["reached"])
            st["used_people"] += len(f["used"])
            st["holder_correct"] += f["holder_correct"]
            for _, relation in f["picked"]:
                rel[r["arm"]][relation] += 1
        n_people[r["arm"]] += r["n"]
        if a.sessions:
            fin = r["answers"][str(r["rounds"])]
            print(f"\n{r['key']}  final correct {sum(v == r['correct'] for v in fin.values())}/{r['n']}  (correct: {r['correct']})")
            for f in fs:
                print(f"  fact {f['fact']} ({f['holder']}): said={f['said']} turns={f['turns']} considered={f['considered']} "
                      f"picked={f['picked']} asked={f['asked']} reached={f['reached']} credited={f['credited']} used={f['used']} holder_correct={f['holder_correct']}")
    print("\n| arm | facts | said | considered | picked | asked | reached | credited | misattributed | people reached | of whom correct | holder correct |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for arm, st in stages.items():
        n = st["facts"] or 1
        print(f"| {arm} | {st['facts']} | {st['said']} | {st['considered']} | {st['picked']} | {st['asked']} | {st['reached']} | "
              f"{st['credited']} | {st['misattributed']} | {st['reached_people']} | {st['used_people']} | {st['holder_correct']} |")
    for arm, c in rel.items():
        print(f"{arm}: relations of picks that carried a hidden fact: {dict(c)}")


if __name__ == "__main__":
    main()
