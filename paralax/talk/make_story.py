#!/usr/bin/env python3
"""The process figures: how fast people reach the right answer by round (all sessions), what in
the workspace helped (all Paralax sessions), and one instance as a swimlane + animation data.
Reads eval/runs/*/results.jsonl, leanings.json and the session files. Writes fig_rounds.svg,
fig_instance.svg, instance.js, and prints the numbers used on the slides."""
import json, os, sys
from collections import defaultdict, Counter
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
EV = os.path.join(os.path.dirname(HERE), "eval")
INK, SOFT, MUTED, LINE, PAPER, WASH = "#1a2b4a", "#33445f", "#7d8698", "#d5d7dc", "#ffffff", "#ece9e1"
plt.rcParams.update({"font.family": "sans-serif", "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
                     "font.size": 11, "axes.edgecolor": LINE, "axes.labelcolor": SOFT, "xtick.color": SOFT, "ytick.color": SOFT,
                     "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})
BENCH = {t["name"]: t for t in json.load(open(os.path.join(EV, "data", "benchmark.json")))}
INSTANCE = ("evacuate_park_dilemma", 0)


def results(run, arm):
    return {(r["task"], r["seed"]): r for r in (json.loads(l) for l in open(os.path.join(EV, "runs", run, "results.jsonl")))
            if r.get("version") and r["arm"] == arm}


def leanings(run):
    return json.load(open(os.path.join(EV, "runs", run, "leanings.json")))


def session(r):
    evs = [json.loads(l) for l in open(r["session"])]
    names = {e["pane"]: e["name"] for e in evs if e["type"] == "name"}
    turns = defaultdict(list)
    for e in evs:
        if e["type"] == "user":
            turns[e["pane"]].append(e["id"])
    hf = {}
    for it in (r.get("funnel") or {}).get("items", []):
        for x in it.get("holder_turns", []):
            if str(x).lstrip("#").isdigit():
                hf.setdefault(int(str(x).lstrip("#")), []).append(it["fact"])
    return evs, names, turns, hf


ARMS = [("isolated", "v1", "independent pairs"), ("workspace", "v7", "Paralax"), ("context", "v1", "everything in context")]

# ------------------------------------------------------------ 1. share leaning correct, by round
curves, first_correct = {}, {}
for arm, run, label in ARMS:
    L = leanings(run)
    res = results(run, arm)
    per_round = defaultdict(list)
    firsts = []
    for key, r in res.items():
        lk = L.get(r["key"])
        if not lk:
            continue
        for p, seq in lk["leanings"].items():
            for i, x in enumerate(seq[:6]):
                per_round[i + 1].append(x == r["correct"])
            f = next((i + 1 for i, x in enumerate(seq[:6]) if x == r["correct"] and all(y == r["correct"] for y in seq[i:6])), None)
            firsts.append(f if f else 7)
    curves[label] = [np.mean(per_round[k]) for k in range(1, 7)]
    first_correct[label] = firsts
fig, ax = plt.subplots(figsize=(8.6, 4.4))
styles = {"independent pairs": (0, (1, 2)), "Paralax": "-", "everything in context": (0, (5, 3))}
for label, ys in curves.items():
    ax.plot(range(1, 7), ys, color=INK, linewidth=2.2, linestyle=styles[label])
    off = {"everything in context": 0.035, "Paralax": -0.035}.get(label, 0)
    ax.text(6.12, ys[-1] + off, label, color=INK, fontsize=10.5, va="center")
ax.set_xlim(0.8, 8.4); ax.set_ylim(0, 1); ax.set_xticks(range(1, 7))
ax.set_xlabel("round (each person's n-th message to their assistant)"); ax.set_ylabel("share of people leaning to the right answer")
ax.set_title("How fast people get there: leaning after each of their messages, judged from their own words", loc="left", color=INK, fontsize=11.5, pad=10)
ax.grid(axis="y", color=LINE, linewidth=0.6); ax.set_axisbelow(True); ax.tick_params(length=0)
fig.tight_layout(); fig.savefig(os.path.join(HERE, "fig_rounds.svg"), bbox_inches="tight", facecolor=PAPER); plt.close(fig)
print("share leaning correct by round:")
for label, ys in curves.items():
    med = int(np.median(first_correct[label]))
    print(f"  {label:24s} " + " ".join(f"{y:.2f}" for y in ys) + f"   median round of settling on the right answer: {'never' if med == 7 else med}"
          f"   (never: {np.mean([f == 7 for f in first_correct[label]]):.0%})")

# ------------------------------------------------------------ 2. what helped: flips to the right answer after a read
L7 = leanings("v7"); res7 = results("v7", "workspace")
flip = Counter(); stay = Counter()
examples = []
for key, r in res7.items():
    lk = L7.get(r["key"])
    if not lk:
        continue
    evs, names, turns, hf = session(r)
    byid = {e["id"]: e for e in evs}
    held = {p: set(BENCH[r["task"]]["hidden_information"].index(h) for h in hs) for p, hs in r["slices"].items()}
    rets = {(e["pane"], e["for_turn"]): e for e in evs if e["type"] == "retrieval"}
    for p, seq in lk["leanings"].items():
        ids = turns[p]
        for i in range(1, min(len(seq), len(ids))):
            prev_turn = ids[i - 1]
            ret = rets.get((p, prev_turn))
            carried = set()
            if ret and ret.get("inform"):
                for x in ret["inform"]:
                    for f in hf.get(x["turn"], []):
                        if f not in held.get(p, set()):
                            carried.add(f)
            cond = "read a hidden fact" if carried else ("read, no hidden fact" if ret and ret.get("inform") else "switch closed")
            was = seq[i - 1] == r["correct"]; now = seq[i] == r["correct"]
            if not was:
                (flip if now else stay)[cond] += 1
print("\nParalax: a person not yet on the right answer; what the reply before their next message had read:")
for cond in ("read a hidden fact", "read, no hidden fact", "switch closed"):
    n = flip[cond] + stay[cond]
    print(f"  {cond:24s} {n:4d} turns, moved to the right answer next: {flip[cond] / n if n else float('nan'):.0%}")
Li = leanings("v1"); resi = results("v1", "isolated")
fi = si = 0
for key, r in resi.items():
    lk = Li.get(r["key"])
    if not lk:
        continue
    for p, seq in lk["leanings"].items():
        for i in range(1, len(seq)):
            if seq[i - 1] != r["correct"]:
                if seq[i] == r["correct"]: fi += 1
                else: si += 1
print(f"  independent pairs (no reads) {fi + si:4d} turns, moved to the right answer next: {fi / (fi + si):.0%}")

# ------------------------------------------------------------ 3. the instance
t = BENCH[INSTANCE[0]]
panels = []
for arm, run in (("workspace", "v7"), ("isolated", "v1")):
    r = results(run, arm)[INSTANCE]
    lk = leanings(run)[r["key"]]
    evs, names, turns, hf = session(r)
    panels.append((arm, r, lk, evs, names, turns, hf))

import re
def plain(t):
    """Excerpt without markdown marks."""
    t = re.sub(r"[*_#`]+", "", t); t = re.sub(r"\s+", " ", t).strip()
    return t


def build_steps(r, lk, evs, names, turns, hf):
    byid = {e["id"]: e for e in evs}
    steps = []
    for e in evs:
        if e["type"] == "user":
            k = turns[e["pane"]].index(e["id"])
            steps.append({"kind": "turn", "id": e["id"], "pane": e["pane"], "round": k + 1, "text": plain(e["text"])[:170],
                          "hf": hf.get(e["id"], []), "leaning": (lk["leanings"].get(e["pane"]) or [None] * 9)[k]})
        elif e["type"] == "retrieval":
            carried = []
            for x in e.get("inform", []):
                for f in hf.get(x["turn"], []):
                    carried.append({"fact": f, "from": byid[x["turn"]]["pane"], "turn": x["turn"]})
            steps.append({"kind": "switch", "pane": e["pane"], "forTurn": e["for_turn"], "open": bool(e.get("inform")),
                          "nread": len(e.get("inform", [])), "carried": carried, "ask": (e.get("ask") or {}).get("turn")})
        elif e["type"] == "agent" and e.get("status") == "done":
            ft = max((x for x in turns[e["pane"]] if x < e["id"]), default=None)
            steps.append({"kind": "reply", "pane": e["pane"], "forTurn": ft, "text": plain(e["text"])[:230], "secs": e.get("secs")})
    return steps

arm, r, lk, evs, names, turns, hf = panels[0]
holders = {BENCH[r["task"]]["hidden_information"].index(h): p for p, hs in r["slices"].items() for h in hs}
data = {"task": r["task"], "correct": r["correct"], "options": t["possible_answers"], "names": names, "hidden": t["hidden_information"],
        "holders": holders, "shared": t["shared_information"], "description": t["description"],
        "paralax": {"steps": build_steps(*panels[0][1:]), "final": r["answers"]["6"]},
        "isolated": {"steps": build_steps(*panels[1][1:]), "final": panels[1][1]["answers"]["6"]}}
open(os.path.join(HERE, "instance.js"), "w").write("window.INSTANCE = " + json.dumps(data, ensure_ascii=False) + ";\n")

# static swimlane, both arms
fig, axes = plt.subplots(2, 1, figsize=(11, 7.2), sharex=True, gridspec_kw={"height_ratios": [1.15, 1]})
for ax, (arm, r, lk, evs, names, turns, hf), title in zip(axes, panels, ("Paralax: what the switch carried, and when each person came round", "Independent pairs: the same people, the same facts, no workspace")):
    panes = sorted(names); y = {p: len(panes) - i for i, p in enumerate(panes)}
    ax.set_yticks([y[p] for p in panes]); ax.set_yticklabels([names[p] + (f"  (holds fact {[k for k, v in holders.items() if v == p][0]})" if p in holders.values() else "  (shared facts only)") for p in panes], color=INK)
    first_seen = {}
    for e in evs:
        if e["type"] == "retrieval" and e.get("inform"):
            rd = turns[e["pane"]].index(e["for_turn"]) + 1
            for x in e["inform"]:
                for f in hf.get(x["turn"], []):
                    src = next(q for q in panes if x["turn"] in turns[q])
                    if src != e["pane"] and (f, e["pane"]) not in first_seen:
                        first_seen[(f, e["pane"])] = (src, turns[src].index(x["turn"]) + 1, rd)
    for (f, dst), (src, r0, r1) in first_seen.items():
        ax.annotate("", xy=(r1 + 0.42, y[dst]), xytext=(r0 + 0.08, y[src]),
                    arrowprops=dict(arrowstyle="-|>", color=MUTED, lw=1.0, alpha=0.7, connectionstyle="arc3,rad=0.25"))
    for p in panes:
        seq = lk["leanings"].get(p) or []
        for k, tid in enumerate(turns[p][:6]):
            lean = seq[k] if k < len(seq) else None
            ok = lean == r["correct"]
            ax.scatter(k + 1, y[p], s=150, facecolor=INK if ok else (PAPER if lean else WASH), edgecolor=INK, linewidth=1.6, zorder=4)
            if lean and not ok:
                ax.text(k + 1, y[p], "×", ha="center", va="center", color=INK, fontsize=11, zorder=5)
            for f in hf.get(tid, []):
                ax.text(k + 1, y[p] + 0.33, f"fact {f}", ha="center", va="bottom", color=PAPER, fontsize=8.5, fontweight="bold",
                        bbox=dict(boxstyle="round,pad=0.2", facecolor=INK, edgecolor="none"), zorder=6)
    ax.set_ylim(0.3, len(panes) + 0.9); ax.set_xlim(0.4, 6.6)
    ax.set_title(title, loc="left", color=INK, fontsize=11.5, pad=8)
    ax.grid(axis="x", color=LINE, linewidth=0.6); ax.set_axisbelow(True); ax.tick_params(length=0)
    for s in ("left", "bottom"): ax.spines[s].set_visible(False)
axes[1].set_xticks(range(1, 7)); axes[1].set_xlabel("round")
fig.text(0.01, 0.005, "filled = leaning to the right answer after that message; × = leaning to a wrong option; empty = undecided. "
         "Arrow: the first time the switch carried a person's hidden fact into another person's reply.", color=MUTED, fontsize=9)
fig.tight_layout(rect=[0, 0.03, 1, 1]); fig.savefig(os.path.join(HERE, "fig_instance.svg"), bbox_inches="tight", facecolor=PAPER); plt.close(fig)
print("\ninstance written:", INSTANCE, "| Paralax final", data["paralax"]["final"], "| isolated final", data["isolated"]["final"])
print("hidden facts:", {i: names[p] for i, p in holders.items()})
