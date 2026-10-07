#!/usr/bin/env python3
"""Two figures from eval/RESULTS.md: the Alsobay task (simulated people against the human study's
numbers), and the three attempts to improve integration, as differences from the adopted
algorithm with the seed-to-seed noise shown. One ink colour; identity by label and marker."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

INK, SOFT, MUTED, LINE, PAPER, WASH = "#1a2b4a", "#33445f", "#7d8698", "#d5d7dc", "#ffffff", "#ece9e1"
plt.rcParams.update({"font.family": "sans-serif", "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
                     "font.size": 11, "axes.edgecolor": LINE, "axes.labelcolor": SOFT, "xtick.color": SOFT, "ytick.color": SOFT,
                     "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})

# ---- 1. the Alsobay task: groups choosing the right city, simulated people vs their humans
arms = ["No help\n(group chat)", "One-off message\nto share", "LLM facilitator\nin the chat", "Paralax\n(private assistants)"]
sim = [0.50, 0.60, 0.80, 0.50]          # 10 seeds each (Paralax: 9/18 on 18 seeds, the same 0.50)
hum = [0.31, 0.21, 0.23, None]          # Alsobay et al. 2025, 281 human groups
fig, ax = plt.subplots(figsize=(9, 4.2))
y = np.arange(len(arms))[::-1]
ax.barh(y + 0.18, sim, height=0.34, color=[MUTED, MUTED, MUTED, INK])
for yi, v in zip(y + 0.18, sim):
    ax.text(v + 0.012, yi, f"{v:.0%}", va="center", color=SOFT, fontsize=10)
for yi, v in zip(y - 0.2, hum):
    if v is not None:
        ax.barh(yi, v, height=0.3, color=PAPER, edgecolor=INK, linewidth=1.4, hatch="////")
        ax.text(v + 0.012, yi, f"{v:.0%} humans", va="center", color=SOFT, fontsize=10)
    else:
        ax.text(0.012, yi, "no human condition", va="center", color=MUTED, fontsize=9.5, style="italic")
ax.set_yticks(y); ax.set_yticklabels(arms, color=INK, fontsize=10.5); ax.set_ylim(-0.7, len(arms) - 0.35)
ax.set_xlim(0, 1.0); ax.set_xticks([0, .25, .5, .75, 1]); ax.set_xticklabels(["0", "25%", "50%", "75%", "100%"])
ax.set_xlabel("groups choosing the right city (Eldoron)")
ax.set_title("The Alsobay task: five simulated committee members (solid) against 281 human groups (hatched)", loc="left", color=INK, fontsize=11.5, pad=10)
ax.grid(axis="x", color=LINE, linewidth=0.6); ax.set_axisbelow(True); ax.tick_params(length=0)
fig.tight_layout(); fig.savefig("fig_alsobay.svg", bbox_inches="tight", facecolor=PAPER); plt.close(fig)

# ---- 2. three attempts: difference in individual accuracy from v7 + decision round
rows = [  # label, HiddenBench (orig, rep, all), Alsobay (orig, rep, all); None where not run
    ("v8  scoreboard + votes", (-0.108, None, None), (-0.24, None, None)),
    ("v9  eliminate, then compare", (-0.042, 0.114, 0.031), (0.22, -0.025, 0.111)),
    ("v10 shared neutral brief", (-0.058, None, None), (-0.10, None, None)),
]
fig, axes = plt.subplots(1, 2, figsize=(11, 3.6), sharey=True)
for ax, idx, title, noise in zip(axes, (1, 2), ("HiddenBench (24 pairs; v9 also 21 more)", "Alsobay task (10 seeds; v9 also 8 more)"), (0.2, 0.17)):
    ax.axvspan(-noise, noise, color=WASH, zorder=0)
    ax.text(0, -0.62, "seed-to-seed noise", ha="center", color=MUTED, fontsize=9)
    ax.axvline(0, color=INK, linewidth=1)
    for i, (label, hb, al) in enumerate(rows):
        yv = len(rows) - 1 - i
        orig, rep, allv = (hb if idx == 1 else al)
        ax.scatter([orig], [yv], s=70, facecolor=PAPER, edgecolor=INK, linewidth=1.8, zorder=4)
        if rep is not None:
            ax.scatter([rep], [yv], s=70, marker="s", facecolor=PAPER, edgecolor=INK, linewidth=1.8, zorder=4)
            ax.plot([orig, rep], [yv, yv], color=MUTED, linewidth=1.2, zorder=3)
            ax.scatter([allv], [yv], s=90, marker="D", facecolor=INK, edgecolor=INK, zorder=5)
            ax.text(allv, yv - 0.36, f"all: {allv:+.2f}", ha="center", color=INK, fontsize=9.5)
        else:
            ax.text(orig, yv - 0.36, f"{orig:+.2f}", ha="center", color=INK, fontsize=9.5)
    ax.set_ylim(-0.8, len(rows) - 0.4); ax.set_xlim(-0.33, 0.33); ax.set_xticks([-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]); ax.set_xticklabels(["−30", "−20", "−10", "0", "+10", "+20", "+30"])
    ax.set_xlabel("points of individual accuracy, relative to the adopted algorithm")
    ax.set_title(title, loc="left", color=INK, fontsize=11, pad=12)
    ax.set_yticks(range(len(rows))); ax.set_yticklabels([r[0] for r in rows][::-1], color=INK, fontsize=10.5)
    ax.grid(axis="x", color=LINE, linewidth=0.6); ax.set_axisbelow(True); ax.tick_params(length=0)
    for s in ("left",): ax.spines[s].set_visible(False)
fig.text(0.01, -0.03, "circle: the first run (seeds 0-1, or 0-9) · square: the replication seeds · diamond: all seeds together. A difference inside the grey band cannot be told from seed luck.", color=MUTED, fontsize=9)
fig.tight_layout(); fig.savefig("fig_attempts.svg", bbox_inches="tight", facecolor=PAPER); plt.close(fig)
print("figures written")
