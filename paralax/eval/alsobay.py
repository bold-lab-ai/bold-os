#!/usr/bin/env python3
"""
Alsobay, Rothschild, Hofman & Goldstein (2025, arXiv 2508.08242): five committee members pick a
host city (Eldoron, Myloria, Cragnio) from five different personal reports. Every report alone
favours Myloria (the bait); pooled, Eldoron wins. Their humans chose Eldoron 31% of the time with
no facilitation, 21% after a one-off message, 30% with a human facilitator, 23% with a GPT-4o
facilitator in the chat. The stimuli are from their MIT-licensed GRAIL platform (HPTConfig.json).

This runs the same task with simulated people under their conditions and under Paralax.

    none      group chat, no help                         (their "None")
    message   group chat, one organiser message at start  (their "Message")
    llm       group chat + an AI facilitator posting every few messages with their prompt ("LLM")
    paralax   private assistants with the shared workspace, no group chat

    PARALAX_ENV=... PARALAX_MODELS=gemini-3.5-flash,gemini-3.8-flash python3 eval/alsobay.py run --run alsobay_dept --seeds 10
    python3 eval/alsobay.py report --run alsobay_dept

--style human adds two traits the humans showed (anchoring on the report's favourite, volunteering
facts only when they support a point or are asked for), for calibration against their numbers.
"""
import argparse, json, os, random, re, sys, time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as SV
import workspace as W
import eval_hidden as E

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "alsobay", "HPTConfig.json")))
CITIES = ["Eldoron", "Myloria", "Cragnio"]
CORRECT = "Eldoron"
GENERAL = CFG["generalInfo"].strip()
PLAYERS = [p["playerName"] for p in CFG["playerConfig"]]             # Green, Blue, Pink, Red, Orange
TASK = {"name": "alsobay_isf", "possible_answers": CITIES, "correct_answer": CORRECT, "description": GENERAL}
ROUNDS = 10
FACILITATE_EVERY = 6          # their facilitator posted every 90 s; ~51 messages per 10-minute chat


def report_of(player):
    txt = next(p["playerContent"] for p in CFG["playerConfig"] if p["playerName"] == player)
    return txt[txt.find("# Personal report"):].strip()


def facts_in(txt):
    out, city = [], None
    for line in txt.splitlines():
        m = re.match(r"##\s+(\w+)", line)
        if m:
            city = m.group(1); continue
        b = re.match(r"\*\s+(.*\S)", line)
        if b and city:
            out.append((city, b.group(1).strip()))
    return out


# The 30 facts are the union of the five reports (the config's "full info" sheet holds only 24 of them).
_union = []
for _p in PLAYERS:
    for _f in facts_in(report_of(_p)):
        if _f not in _union:
            _union.append(_f)
ALL_FACTS = sorted(_union, key=lambda cf: (CITIES.index(cf[0]), _union.index(cf)))
HELD = {p: set(ALL_FACTS.index(f) for f in facts_in(report_of(p))) for p in PLAYERS}


def full_information():
    """All 30 facts as one report, for the ceiling check."""
    return "\n".join(["# Full report", *[f"## {c}\n" + "\n".join(f"* {f}" for cc, f in ALL_FACTS if cc == c) for c in CITIES]])

STYLE_EXTRA = {
    "department": "",
    "human": ("You behave like a busy committee member: you form a first preference from your own report and defend it, you bring up "
              "a fact from your report only when it supports your point or someone asks you directly, and you tend to repeat what "
              "others have already said rather than add something new. You do not read anyone's report but your own."),
}

CHAT_PERSONA = """You are {name}, {role} in a research department, serving on this committee. {character} {extra}

{general}

{report}

You are in a ten-minute group chat with the other four committee members ({others}) to agree on the host city. Each turn, write one message to the group, in character: say what you think, bring up what you know when it is relevant to you, ask the others what they know, and react to what they have said. Do not paste your whole report. Write only your next message, at most four sentences, in your own voice."""

PRIVATE_PERSONA = """You are {name}, {role} in a research department, serving on this committee. {character} {extra}

{general}

{report}

You are one of five committee members ({others} and you) who must agree on the host city. Each of you talks privately with your own AI assistant; you cannot talk to the other members directly, and you do not know what their reports say. Your assistant knows nothing about this until you tell it. In your first message, describe the decision in your own words: the three cities and what you have to decide. After that, have a natural working conversation: bring up what your report says when it is relevant, ask questions, and react to what your assistant tells you. Do not paste your whole report. Write only your next message to your assistant, at most four sentences, in your own voice."""

ORGANISER_MESSAGE = ("People may have different information about what is being discussed in this meeting, so encourage everyone "
                     "to share all of the relevant information they have.")

FACILITATOR_SYSTEM = """You are an AI facilitator joining a ten-minute online meeting of a five-person committee at the International Sports Federation. Meeting objective: select the host city for the next event from Eldoron, Myloria and Cragnio. Attendees: {attendees}. Time elapsed: about {elapsed} minutes; time remaining: about {remaining} minutes.

Your specific role is to help the group make a decision by, first, making sure that everyone is heard from and shares what they know and, second, acting as a scoreboard and keeping track of pros and cons. You may address specific members by name. Keep messages short.

You will be given the full timestamped transcript so far. Return JSON only: {{"MESSAGE": "<what you post to the group>", "RATIONALE": "<why>"}}"""

FACTS_JUDGE = """You are given a numbered list of facts about three cities and a group transcript. For each fact, say which participants (not the facilitator or organiser) stated its content, in their own words or otherwise. Judge content, not wording; a fact counts if a participant conveyed it. Return JSON only: {"mentioned": [{"fact": <number>, "by": [names]}]} listing only facts that at least one participant stated."""

LEAN_JUDGE = """You read one person's messages, in order, and say which city they leaned towards after each message, judged only from what they wrote: a stated choice, a clear preference, or a city they argue for. If they have not committed, answer null. Return JSON only: {"leanings": ["Eldoron" | "Myloria" | "Cragnio" | null, ...]} with one entry per message, in order."""


def persona_system(i, arm, style):
    p = E.PERSONAS[i]
    name = PLAYERS[i]
    others = ", ".join(q for q in PLAYERS if q != name)
    tmpl = PRIVATE_PERSONA if arm == "paralax" else CHAT_PERSONA
    return tmpl.format(name=name, role=p["role"], character=p["character"], extra=STYLE_EXTRA[style],
                       general=GENERAL, report=report_of(name), others=others)


def ask_city(system, user):
    v = E.ask_json(system, user, E.HUMAN_MODELS)
    return E.norm_answer(v.get("answer"), CITIES)


# ------------------------------------------------------------------ chat arms

def facilitate(S, round_no):
    with S.lock:
        posts = [e for e in S.events if e["type"] == "user"]
    transcript = "\n".join(f"[{i + 1}] {S.names[e['pane']]}: {e['text']}" for i, e in enumerate(posts))
    system = FACILITATOR_SYSTEM.format(attendees=", ".join(PLAYERS), elapsed=round_no, remaining=max(0, ROUNDS - round_no))
    try:
        _, _, d = SV.llm(system, [SV.turn("user", "TRANSCRIPT\n" + transcript)], SV.AGENT_MODELS, json_mode=True, max_tokens=400,
                         check=lambda raw: json.loads(raw[raw.find("{"): raw.rfind("}") + 1]))
        msg = str(d.get("MESSAGE") or "").strip()
    except Exception as e:                                  # noqa: BLE001
        SV.log(f"facilitator failed: {str(e)[:80]}"); msg = ""
    if msg:
        S.add({"type": "user", "pane": "F", "name": "Facilitator", "text": msg[:1200]})


def run_chat(arm, seed, style, run_dir):
    panes = ["A", "B", "C", "D", "E"] + (["F"] if arm in ("message", "llm") else [])
    S = E.fresh_state(panes, f"alsobay__{arm}__{style}__s{seed}", run_dir)
    for i, p in enumerate(panes[:5]):
        S.add({"type": "name", "pane": p, "name": PLAYERS[i]})
    if "F" in panes:
        S.add({"type": "name", "pane": "F", "name": "Organiser" if arm == "message" else "Facilitator"})
    S.add({"type": "settings", "settings": {"mode": "isolated"}})
    if arm == "message":
        S.add({"type": "user", "pane": "F", "name": "Organiser", "text": ORGANISER_MESSAGE})
    sysm = {p: persona_system(i, arm, style) for i, p in enumerate(panes[:5])}
    order_rng = random.Random(f"order-{seed}")
    t0 = time.time(); answers = {}; posts = 0
    for r in range(1, ROUNDS + 1):
        order = panes[:5]; order_rng.shuffle(order)
        for p in order:
            S.add({"type": "user", "pane": p, "name": S.names[p], "text": E.chat_message(S, p, sysm[p])})
            posts += 1
            if arm == "llm" and posts % FACILITATE_EVERY == 0:
                facilitate(S, r)
        if r in (ROUNDS // 2, ROUNDS):
            with ThreadPoolExecutor(5) as ex:
                answers[r] = dict(zip(panes[:5], ex.map(lambda p: E.chat_answer(S, p, sysm[p], TASK), panes[:5])))
    return S, answers, round(time.time() - t0, 1)


# ------------------------------------------------------------------ Paralax arm

def run_paralax(seed, style, run_dir, decide=False):
    panes = ["A", "B", "C", "D", "E"]
    S = E.fresh_state(panes, f"alsobay__paralax__{style}__s{seed}", run_dir)
    for i, p in enumerate(panes):
        S.add({"type": "name", "pane": p, "name": PLAYERS[i]})
    S.add({"type": "settings", "settings": {"mode": "workspace"}})
    sysm = {p: persona_system(i, "paralax", style) for i, p in enumerate(panes)}
    stagger = random.Random(f"stagger-{seed}")
    t0 = time.time(); answers = {}

    def one_turn(p, delay, final):
        time.sleep(delay)
        SV.handle_send(S, p, E.persona_message(S, p, sysm[p], final=final))

    for r in range(1, ROUNDS + 1):
        delays = {p: stagger.uniform(0, 3.0) for p in panes}
        final = decide and r == ROUNDS
        with ThreadPoolExecutor(5) as ex:
            list(ex.map(lambda p: one_turn(p, delays[p], final), panes))
        if r in (ROUNDS // 2, ROUNDS):
            with ThreadPoolExecutor(5) as ex:
                answers[r] = dict(zip(panes, ex.map(lambda p: E.persona_answer(S, p, sysm[p], TASK), panes)))
    return S, answers, round(time.time() - t0, 1)


# ------------------------------------------------------------------ measures

def facts_shared(S):
    """Which of the facts did participants state, and by whom (chat posts, or messages to assistants)."""
    with S.lock:
        posts = [e for e in S.events if e["type"] == "user" and e["pane"] != "F"]
    transcript = "\n".join(f"{S.names[e['pane']]}: {e['text']}" for e in posts)
    user = ("FACTS\n" + "\n".join(f"{i}. ({c}) {f}" for i, (c, f) in enumerate(ALL_FACTS)) + "\n\nTRANSCRIPT\n" + transcript)
    try:
        _, _, d = SV.llm(FACTS_JUDGE, [SV.turn("user", user)], E.JUDGE_MODELS, json_mode=True, max_tokens=1500,
                         check=lambda raw: json.loads(raw[raw.find("{"): raw.rfind("}") + 1]))
        out = {}
        for x in d.get("mentioned", []):
            if isinstance(x, dict) and str(x.get("fact", "")).isdigit() and int(x["fact"]) < len(ALL_FACTS):
                out[int(x["fact"])] = [n for n in x.get("by", []) if n in PLAYERS]
        return out
    except Exception as e:                                  # noqa: BLE001
        SV.log(f"facts judge failed: {str(e)[:80]}")
        return None


def leanings(S):
    out = {}
    for p in ["A", "B", "C", "D", "E"]:
        msgs = [e["text"] for e in S.conv(p) if e["type"] == "user"]
        try:
            _, _, d = SV.llm(LEAN_JUDGE, [SV.turn("user", "\n".join(f"{i + 1}. {m}" for i, m in enumerate(msgs)))], E.JUDGE_MODELS,
                             json_mode=True, max_tokens=300, check=lambda raw: json.loads(raw[raw.find("{"): raw.rfind("}") + 1]))
            seq = [E.norm_answer(x, CITIES) if x else None for x in (d.get("leanings") or [])][:len(msgs)]
            out[p] = seq + [None] * (len(msgs) - len(seq))
        except Exception:                                   # noqa: BLE001
            out[p] = [None] * len(msgs)
    return out


def run(args):
    run_dir = os.path.join(HERE, "runs", args.run); os.makedirs(run_dir, exist_ok=True)
    out = os.path.join(run_dir, "results.jsonl"); have = E.done_keys(out)
    arms = [a for a in args.arms.split(",") if a]
    jobs = [(arm, s) for s in range(args.seeds) for arm in arms if f"{arm}|{s}" not in have]
    SV.log(f"alsobay run {args.run}: style={args.style}, {len(jobs)} sessions, arms={arms}, {args.workers} workers")

    def job(j):
        arm, seed = j
        try:
            S, answers, secs = run_paralax(seed, args.style, run_dir, decide=args.decide) if arm == "paralax" else run_chat(arm, seed, args.style, run_dir)
            fin = answers[ROUNDS]
            c = Counter(v for v in fin.values() if v); top = c.most_common()
            majority = None if not top or (len(top) > 1 and top[0][1] == top[1][1]) else top[0][0]
            shared = facts_shared(S)
            rec = {"key": f"{arm}|{seed}", "arm": arm, "seed": seed, "style": args.style, "version": W.VERSION, "decide": args.decide, "correct": CORRECT,
                   "answers": answers, "majority": majority, "facts_shared": shared, "leanings": leanings(S),
                   "secs": secs, "session": os.path.relpath(S.path, HERE)}
            rec.update(E.session_stats(S))
            E.append(out, rec)
            SV.log(f"DONE {rec['key']} majority={majority} individual={sum(v == CORRECT for v in fin.values())}/5 facts={len(shared) if shared else '?'} {secs}s")
        except Exception as e:                              # noqa: BLE001
            SV.log(f"FAILED {arm}|{seed}: {e!r}")

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(job, jobs))
    SV.log("run finished")


def report(args):
    rows = [json.loads(l) for l in open(os.path.join(HERE, "runs", args.run, "results.jsonl")) if l.strip()]
    human = {"none": "31%", "message": "21%", "llm": "23%", "human facilitator": "30%"}
    lines = [f"run {args.run} | style {sorted(set(r['style'] for r in rows))} | sessions {len(rows)} | facts in the task {len(ALL_FACTS)}", "",
             "| arm | sessions | groups choosing Eldoron | humans (Alsobay 2025) | individual accuracy | facts shared (of all) | everyone shared >= 1 fact | leaning Eldoron by round |",
             "|---|---|---|---|---|---|---|---|"]
    for arm in ("none", "message", "llm", "paralax"):
        rs = [r for r in rows if r["arm"] == arm]
        if not rs:
            continue
        maj = sum(r["majority"] == CORRECT for r in rs) / len(rs)
        ind = sum(sum(v == CORRECT for v in r["answers"][str(ROUNDS)].values()) / 5 for r in rs) / len(rs)
        fs = [len(r["facts_shared"]) for r in rs if r.get("facts_shared") is not None]
        part = [all(any(p in by for by in r["facts_shared"].values()) for p in PLAYERS) for r in rs if r.get("facts_shared")]
        per = {k: [] for k in range(1, ROUNDS + 1)}
        for r in rs:
            for p, seq in (r.get("leanings") or {}).items():
                for i, x in enumerate(seq[:ROUNDS]):
                    per[i + 1].append(x == CORRECT)
        curve = " ".join(f"{sum(v) / len(v):.2f}" if v else "-" for k, v in sorted(per.items()))
        lines.append(f"| {arm} | {len(rs)} | {maj:.0%} | {human.get(arm, '-')} | {ind:.2f} | {sum(fs) / len(fs) if fs else float('nan'):.1f} | "
                     f"{sum(part) / len(part) if part else float('nan'):.0%} | {curve} |")
    text = "\n".join(lines)
    open(os.path.join(HERE, "runs", args.run, "summary.md"), "w").write(text + "\n"); print(text)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("--run", required=True); r.add_argument("--seeds", type=int, default=10)
    r.add_argument("--arms", default="none,message,llm,paralax"); r.add_argument("--style", default="department", choices=list(STYLE_EXTRA))
    r.add_argument("--workers", type=int, default=4); r.add_argument("--decide", action="store_true")
    q = sub.add_parser("report"); q.add_argument("--run", required=True)
    a = ap.parse_args()
    {"run": run, "report": report}[a.cmd](a)


if __name__ == "__main__":
    main()
