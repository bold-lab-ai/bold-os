#!/usr/bin/env python3
"""Group size under a fixed meeting length: the five-person runs (chat, v7d) against the eight-person
runs (n8: chat with 5 speaking slots per round + Paralax; n8_open: chat with everyone speaking).
Prints individual accuracy, plurality, the paired difference within N = 8, seed noise, and cost."""
import json, os, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import eval_hidden as E

HERE = os.path.dirname(os.path.abspath(__file__))


def rows(run):
    p = os.path.join(HERE, "runs", run, "results.jsonl")
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def holders_acc(r):
    """Accuracy of the people who hold a hidden fact, and of those who hold only shared facts."""
    a = r["answers"].get(str(E.final_round(r))) or {}
    h = [p for p in a if r["slices"].get(p)]
    s = [p for p in a if not r["slices"].get(p)]
    return (mean([a[p] == r["correct"] for p in h]) if h else float("nan"),
            mean([a[p] == r["correct"] for p in s]) if s else float("nan"))


ARMS = [("5 people, room (everyone speaks)", "chat", "chat", lambda r: True),
        ("5 people, Paralax", "v7d", "workspace", lambda r: r["seed"] in (0, 1)),
        ("8 people, room, 5 slots per round", "n8", "chat", lambda r: True),
        ("8 people, room (everyone speaks)", "n8_open", "chat", lambda r: True),
        ("8 people, Paralax", "n8", "workspace", lambda r: True)]
lines = ["| arm | sessions | individual acc | plurality | holders right | non-holders right | posts or messages / session | assistant calls / session |",
         "|---|---|---|---|---|---|---|---|"]
sets = {}
for label, run, arm, keep in ARMS:
    rs = [r for r in rows(run) if r["arm"] == arm and keep(r)]
    sets[label] = rs
    if not rs:
        continue
    ha = [holders_acc(r) for r in rs]
    posts = mean([r.get("replies", 0) if arm != "chat" else (r.get("floor") or r["n"]) * r["rounds"] for r in rs])
    lines.append(f"| {label} | {len(rs)} | {mean([E.ind_acc(r) for r in rs]):.3f} | {mean([E.plurality(r) for r in rs]):.2f} | "
                 f"{mean([h for h, _ in ha]):.2f} | {mean([s for _, s in ha if s == s]):.2f} | {posts:.0f} | {mean([r.get('assistant_calls', 0) for r in rs]):.0f} |")
print("\n".join(lines)); print()


def paired(a, b):
    A = {(r["task"], r["seed"]): r for r in sets.get(a, [])}
    B = {(r["task"], r["seed"]): r for r in sets.get(b, [])}
    ks = sorted(set(A) & set(B))
    d = [E.ind_acc(A[k]) - E.ind_acc(B[k]) for k in ks]
    g = [E.plurality(A[k]) - E.plurality(B[k]) for k in ks]
    if ks:
        print(f"{a}  minus  {b}: {len(ks)} pairs | individual {mean(d):+.3f} (one-sided p = {E.perm_test(d):.3f}) | plurality {mean(g):+.3f} (p = {E.perm_test(g):.3f})")


paired("8 people, Paralax", "8 people, room, 5 slots per round")
paired("8 people, Paralax", "8 people, room (everyone speaks)")
paired("8 people, room (everyone speaks)", "8 people, room, 5 slots per round")
paired("5 people, Paralax", "5 people, room (everyone speaks)")
paired("5 people, Paralax", "8 people, Paralax")
paired("5 people, room (everyone speaks)", "8 people, room, 5 slots per round")
print()
for label, rs in sets.items():
    s0 = {r["task"]: r for r in rs if r["seed"] == 0}; s1 = {r["task"]: r for r in rs if r["seed"] == 1}
    ks = sorted(set(s0) & set(s1))
    if ks:
        print(f"noise {label}: mean |seed0 - seed1| = {mean([abs(E.ind_acc(s0[k]) - E.ind_acc(s1[k])) for k in ks]):.3f} over {len(ks)} tasks")
