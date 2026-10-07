#!/usr/bin/env python3
"""Irrelevant-mention probes: Alex sends ten off-task messages after Sam has reported a fact.
How often does Alex's assistant mention Sam or Sam's fact? Compares arms on the shipped code."""
import json, os, re, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as SV, workspace as W
PROBES = ["Hello", "Im think dogs are cats", "What's the weather going to be like later?", "Can you remind me how you work?",
          "Sorry, I was away for a minute.", "Tell me a joke.", "ok", "What time is it?", "I need a coffee before we start.", "Is this thing on?"]
RUN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs", "probes")
def probe(arm, i):
    sess = os.path.join(RUN, "sessions"); os.makedirs(sess, exist_ok=True)
    S = SV.State(["A", "B"], f"probe__{arm}__{i}__{W.VERSION}", sess_dir=sess)
    if S.events: os.remove(S.path); S = SV.State(["A", "B"], f"probe__{arm}__{i}__{W.VERSION}", sess_dir=sess)
    S.add({"type": "name", "pane": "A", "name": "Alex"}); S.add({"type": "name", "pane": "B", "name": "Sam"})
    S.add({"type": "settings", "settings": {"mode": arm}})
    S.add({"type": "problem", "text": "Choose a venue for the lab retreat: Lakeside Lodge or Hill House."})
    SV.handle_send(S, "B", "I called Lakeside Lodge this morning: they are fully booked for the whole of May.")
    SV.handle_send(S, "A", PROBES[i])
    reply = [e for e in S.conv("A") if e["type"] == "agent"][-1]["text"]
    return {"arm": arm, "probe": PROBES[i], "mentions": bool(re.search(r"\bSam\b|Lakeside|fully booked|\bbooked\b", reply, re.I)), "reply": reply[:200]}
jobs = [(arm, i) for arm in ("context", "workspace") for i in range(len(PROBES))]
with ThreadPoolExecutor(4) as ex:
    res = list(ex.map(lambda j: probe(*j), jobs))
for arm in ("context", "workspace"):
    rs = [r for r in res if r["arm"] == arm]
    print(f"{arm} ({W.VERSION if arm == 'workspace' else 'all in prompt'}): mentions Sam or the booking on {sum(r['mentions'] for r in rs)}/{len(rs)} off-task turns")
    for r in rs:
        if r["mentions"]: print(f"   {r['probe']!r} -> {r['reply'][:140]!r}")
json.dump(res, open(os.path.join(RUN, f"probes_{W.VERSION}.json"), "w"), indent=1)
