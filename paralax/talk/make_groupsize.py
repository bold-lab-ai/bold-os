#!/usr/bin/env python3
"""Two panels from eval/RESULTS.md (8 Oct): left, individual accuracy at five and eight people for the
room and for Paralax; right, what removing the relay of others' choices did (adopted, v11, v12) at
both sizes: relay rate against accuracy. One ink colour; identity by marker and label."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

INK, SOFT, MUTED, LINE, PAPER, WASH = "#1a2b4a", "#33445f", "#7d8698", "#d5d7dc", "#ffffff", "#ece9e1"
plt.rcParams.update({"font.family": "sans-serif", "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
                     "font.size": 11, "axes.edgecolor": LINE, "axes.labelcolor": SOFT, "xtick.color": SOFT, "ytick.color": SOFT,
                     "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})
fig, (ax, bx) = plt.subplots(1, 2, figsize=(11.5, 4.0), gridspec_kw={"width_ratios": [1.1, 1]})

# ---- left: five vs eight people
arms = [("room, everyone speaks", [0.750, 0.682], MUTED, "//"), ("room, 5 speaking slots", [None, 0.714], MUTED, ""),
        ("Paralax (adopted)", [0.858, 0.740], INK, "")]
x = np.array([0, 1]); w = 0.24
for i, (lab, vals, col, hatch) in enumerate(arms):
    for j, v in enumerate(vals):
        if v is None:
            continue
        ax.bar(x[j] + (i - 1) * w, v, w * 0.92, color=PAPER if hatch else col, edgecolor=col, linewidth=1.4, hatch=hatch or None, label=lab if j == (0 if vals[0] is not None else 1) else None)
        ax.text(x[j] + (i - 1) * w, v + 0.012, f"{v:.2f}", ha="center", color=SOFT, fontsize=9.5)
ax.axhline(0.142, color=INK, linewidth=0.8, linestyle=(0, (2, 3))); ax.text(-0.57, 0.158, "independent pairs .14", ha="left", color=MUTED, fontsize=9)
ax.set_xticks(x); ax.set_xticklabels(["five people\n(3-4 hold a hidden fact)", "eight people\n(4 of 8 hold a hidden fact)"], color=INK, fontsize=10.5)
ax.set_ylim(0, 1.0); ax.set_ylabel("individual accuracy at the end"); ax.set_xlim(-0.6, 1.5)
ax.legend(frameon=False, fontsize=9.5, loc="upper right"); ax.grid(axis="y", color=LINE, linewidth=0.6); ax.set_axisbelow(True); ax.tick_params(length=0)
ax.set_title("Eight people, same meeting length: the room holds, Paralax falls to it", loc="left", color=INK, fontsize=11, pad=10)

# ---- right: relay rate vs accuracy
pts = {5: [("adopted", 0.60, 0.858), ("v11", 0.31, 0.800), ("v12", 0.08, 0.792)],
       8: [("adopted", 0.59, 0.740), ("v11", 0.45, 0.797), ("v12", 0.11, 0.776)]}
for n, mk in ((5, "o"), (8, "s")):
    rs = [r for _, r, _ in pts[n]]; acc = [a for _, _, a in pts[n]]
    bx.plot(rs, acc, color=INK if n == 5 else MUTED, linewidth=1.2, zorder=2)
    bx.scatter(rs, acc, s=70, marker=mk, facecolor=PAPER if n == 8 else INK, edgecolor=INK, linewidth=1.6, zorder=3, label=f"{n} people")
    for lab, r, a in pts[n]:
        bx.text(r, a + (0.022 if n == 5 else -0.036), lab, ha="center", color=SOFT, fontsize=9)
bx.axhspan(0.74, 0.86, color=WASH, zorder=0); bx.text(0.33, 0.724, "band: seed noise .15 to .22", ha="center", color=MUTED, fontsize=9)
bx.set_xlim(0.66, 0.0); bx.set_ylim(0.6, 0.95); bx.set_xticks([0.6, 0.4, 0.2, 0]); bx.set_xticklabels(["60%", "40%", "20%", "0"])
bx.set_xlabel("final-round replies relaying what others chose (removed, at the right)"); bx.set_ylabel("individual accuracy")
bx.legend(frameon=False, fontsize=9.5, loc="lower left"); bx.grid(color=LINE, linewidth=0.6); bx.set_axisbelow(True); bx.tick_params(length=0)
bx.set_title("Removing the relay of choices changes nothing beyond noise", loc="left", color=INK, fontsize=11, pad=10)
fig.tight_layout(w_pad=2.5); fig.savefig("fig_groupsize.svg", bbox_inches="tight", facecolor=PAPER); plt.close(fig)
print("fig_groupsize.svg written")
