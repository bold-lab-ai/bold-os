#!/usr/bin/env python3
"""Figures for the talk, from eval/RESULTS.md numbers. One ink colour (BOLD OS), identity by label and dash, never by hue."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

INK, SOFT, MUTED, LINE, PAPER = "#1a2b4a", "#33445f", "#7d8698", "#d5d7dc", "#ffffff"
plt.rcParams.update({"font.family": "sans-serif", "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
                     "font.size": 11, "axes.edgecolor": LINE, "axes.labelcolor": SOFT, "xtick.color": SOFT, "ytick.color": SOFT,
                     "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})

def clean(ax):
    ax.tick_params(length=0)
    ax.grid(axis="x", color=LINE, linewidth=0.6)
    ax.set_axisbelow(True)

# ---- 1. results: individual accuracy and group correct per arm
arms = ["Independent pairs\n(no workspace)", "Paralax, first version\n(hand over 2 items per turn)", "Paralax as adopted\n(switch, whole workspace)", "Everything in context\n(every turn, no switch)", "Full information\n(ceiling)"]
ind = [0.14, 0.625, 0.825, 0.908, 0.967]
grp = [0.00, 0.583, 0.875, 0.958, 1.00]
fig, axes = plt.subplots(1, 2, figsize=(11, 3.9), sharey=True)
for ax, vals, title in zip(axes, (ind, grp), ("Individual accuracy at the end", "Sessions where the group's plurality was right")):
    y = np.arange(len(arms))[::-1]
    colors = [MUTED, MUTED, INK, MUTED, MUTED]
    ax.barh(y, vals, color=colors, height=0.58)
    for yi, v in zip(y, vals):
        ax.text(v + 0.015, yi, f"{v:.2f}", va="center", color=SOFT, fontsize=10.5)
    ax.set_xlim(0, 1.12); ax.set_title(title, loc="left", color=INK, fontsize=12, pad=10)
    ax.set_xticks([0, .25, .5, .75, 1]); clean(ax)
axes[0].set_yticks(np.arange(len(arms))[::-1]); axes[0].set_yticklabels(arms, color=INK, fontsize=10.5)
fig.text(0.01, -0.04, "HiddenBench, 12 tasks x 2 seeds, 5 simulated people (gemini-3.5-flash-lite) each with their own assistant (gemini-3.5-flash). Paired on the same sessions.", color=MUTED, fontsize=9)
fig.tight_layout(); fig.savefig("fig_results.svg", bbox_inches="tight", facecolor=PAPER); fig.savefig("fig_results.png", bbox_inches="tight", facecolor=PAPER, dpi=110); plt.close(fig)

# ---- 2. versions: accuracy vs how much of the workspace reached the assistant
labels = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "context"]
items  = [18.7, 22.0, 23.2, 28.4, 49.8, 212.8, 327.3, 420]
acc    = [0.625, 0.625, 0.675, 0.667, 0.700, 0.792, 0.825, 0.908]
notes = {"v1": "2 picks per turn,\nnever repeated", "v5": "ids only, no labels\nor reasons",
         "v6": "switch: open =\nread everything", "v7": "switch closes only\nfor small talk", "context": "no switch"}
fig, ax = plt.subplots(figsize=(9.5, 4.6))
ax.plot(items, acc, color=INK, linewidth=2, zorder=2)
ax.scatter(items, acc, s=55, color=PAPER, edgecolor=INK, linewidth=2, zorder=3)
place = {"v1": (-0.5, 0.045, "right"), "v2": (0, -0.05, "center"), "v3": (0, 0.03, "center"), "v4": (0.5, -0.05, "left"),
         "v5": (0.6, 0.03, "left"), "v6": (-0.6, 0.03, "right"), "v7": (0.6, 0.03, "left"), "context": (-0.6, 0.03, "right")}
for x, y, l in zip(items, acc, labels):
    dx, dy, ha = place[l]
    xx = x * (1.08 if dx > 0 else 0.93 if dx < 0 else 1)
    ax.text(xx, y + dy, l, color=INK, fontsize=10.5, fontweight="bold", ha=ha, va="bottom" if dy > 0 else "top")
    if l in notes:
        ax.text(xx, y + dy + (0.0 if dy < 0 else -0.004) - 0.02, notes[l], color=MUTED, fontsize=8.5, ha=ha, va="top")
ax.axhline(0.142, color=MUTED, linewidth=1, linestyle=(0, (3, 3)))
ax.text(16, 0.152, "independent pairs 0.14", color=MUTED, fontsize=9)
ax.set_xscale("log"); ax.set_xlim(12, 700); ax.set_ylim(0.05, 1.0)
from matplotlib.ticker import NullFormatter; ax.xaxis.set_minor_formatter(NullFormatter())
ax.set_xticks([20, 50, 100, 200, 400]); ax.set_xticklabels(["20", "50", "100", "200", "400"])
ax.set_xlabel("workspace items read by the assistants per session (log scale)")
ax.set_ylabel("individual accuracy at the end")
ax.set_title("Accuracy rose with how much of the workspace reached the assistant", loc="left", color=INK, fontsize=12, pad=10)
ax.grid(axis="y", color=LINE, linewidth=0.6); ax.set_axisbelow(True); ax.tick_params(length=0)
fig.tight_layout(); fig.savefig("fig_versions.svg", bbox_inches="tight", facecolor=PAPER); fig.savefig("fig_versions.png", bbox_inches="tight", facecolor=PAPER, dpi=110); plt.close(fig)

# ---- 3. scaling: cost per reply, and the regimes where the next design is needed
m = 60                          # tokens per typed message (measured mean in our sessions ~55)
fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.9))
ax = axes[0]
N = np.arange(2, 41)
for T, ls, lab in ((6, "-", "6 turns each (this study)"), (20, (0, (5, 3)), "20 turns each"), (50, (0, (1, 2)), "50 turns each")):
    W = (N - 1) * T * m / 2                     # mean workspace size over the session
    ax.plot(N, 2 * W / 1000, color=INK, linewidth=2, linestyle=ls)
    ax.text(N[-1] + 0.6, 2 * W[-1] / 1000, lab, color=INK, fontsize=9.5, va="center")
ax.set_xlim(2, 52); ax.set_xlabel("people in the group (N)"); ax.set_ylabel("thousand tokens read per reply (switch + reply)")
ax.set_title("Cost: two calls per reply, each reading the workspace", loc="left", color=INK, fontsize=12, pad=10)
ax.text(2.5, ax.get_ylim()[1] * 0.93 if ax.get_ylim()[1] > 0 else 1, "calls per reply stay at 2 for any N;\ntokens grow with N x turns x message length", color=MUTED, fontsize=9, va="top")
ax.grid(axis="y", color=LINE, linewidth=0.6); ax.set_axisbelow(True); ax.tick_params(length=0)
ax = axes[1]
n = np.linspace(2, 40, 300); t = np.linspace(2, 100, 300); NN, TT = np.meshgrid(n, t)
W_items = (NN - 1) * TT                         # items in the workspace at the end of a session
levels = [0, 60, 600, 1e9]
ax.contourf(NN, TT, W_items, levels=levels, colors=["#ffffff", "#e6e9ef", "#c9ced9"])
cs = ax.contour(NN, TT, W_items, levels=[60, 600], colors=[INK, INK], linewidths=[1.5, 1.5], linestyles=["-", (0, (5, 3))])
for x, y, k in ((4.3, 11, "1"), (16, 20, "2"), (29, 72, "3")):
    ax.text(x, y, k, color=INK, fontsize=15, fontweight="bold", ha="center", va="center")
fig.text(0.015, 0.045, "1  whole-workspace read (this study: N = 5, 6 turns, 24 items)        2  retrieval over a claims index: the switch picks the items that bear,\n"
         "    each pointing back to its turn        3  tiered memory: index, per-person reading record, and a digest that keeps provenance",
         color=INK, fontsize=9.3, va="bottom")
ax.scatter([5], [6], s=70, color=INK, zorder=5)
ax.set_xlabel("people in the group (N)"); ax.set_ylabel("turns per person")
ax.set_title("Where the next design is needed (boundaries: 60 and 600 items)", loc="left", color=INK, fontsize=12, pad=10)
ax.tick_params(length=0)
fig.tight_layout(rect=[0, 0.11, 1, 1]); fig.savefig("fig_scaling.svg", bbox_inches="tight", facecolor=PAPER); fig.savefig("fig_scaling.png", bbox_inches="tight", facecolor=PAPER, dpi=110); plt.close(fig)
print("figures written")
