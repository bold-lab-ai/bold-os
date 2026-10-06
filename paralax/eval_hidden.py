#!/usr/bin/env python3
"""
Does background selection from the shared workspace help a group decide better than putting
everything in context? A hidden-profile test on HiddenBench (Li, Naito & Shirado, ICML 2026;
arXiv 2505.11556; data: huggingface.co/datasets/YuxuanLi1225/HiddenBench, MIT licence).

Each task has shared facts that point to a decoy and hidden facts, one per person, that point to
the right option. Four simulated people each talk only to their own assistant, which runs the
shipped server code (server.handle_send) in one of three modes:

    isolated    no workspace (floor)
    context     everything the others typed is in the reply prompt, same rules (the control)
    workspace   background selection (the proposal)
    full        isolated, but every person holds every fact (pipeline ceiling)

Steps (each resumable; results append to eval/runs/<run>/):
    python3 eval_hidden.py calibrate            # one-call full-info and shared-only answers per task
    python3 eval_hidden.py run --run main       # the sessions
    python3 eval_hidden.py report --run main    # table, paired permutation test, adopt decision

Pre-registered adopt rule (README): workspace is adopted if it beats context by >= 15 points in
mean individual accuracy at turn 6 (one-sided paired permutation p < .05), or if it is within
5 points and cuts the irrelevant-mention rate from >= 20% to <= 5%; otherwise context is shipped.
"""
import argparse, json, os, random, re, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

import server as SV
import workspace as W

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "eval", "data", "benchmark.json")
RUNS = os.path.join(HERE, "eval", "runs")
DATA_URL = "https://huggingface.co/datasets/YuxuanLi1225/HiddenBench/resolve/main/benchmark.json"
NAMES = ["Alex", "Sam", "Robin", "Jordan"]
PERSONA_MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite"]
JUDGE_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"]
ROUNDS, ANSWER_AT = 6, (3, 6)
_write = threading.Lock()


def load_tasks():
    if not os.path.exists(DATA):
        import urllib.request
        os.makedirs(os.path.dirname(DATA), exist_ok=True)
        urllib.request.urlretrieve(DATA_URL, DATA)
    return json.load(open(DATA))


def problem_text(t):
    return (t["description"].strip() + "\n\nThe group must agree on one option: " + ", ".join(t["possible_answers"]) + ".")


def ask_json(system, user, models, max_tokens=300):
    _, _, val = SV.llm(system, [SV.turn("user", user)], models, json_mode=True, max_tokens=max_tokens,
                       check=lambda raw: json.loads(raw[raw.find("{"): raw.rfind("}") + 1]))
    return val


def norm_answer(ans, options):
    a = str(ans or "").strip().lower()
    for o in options:
        if a == o.lower():
            return o
    hits = [o for o in options if o.lower() in a]
    return hits[0] if len(hits) == 1 else None


def append(path, rec):
    with _write:
        with open(path, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def done_keys(path):
    if not os.path.exists(path):
        return set()
    return {json.loads(l)["key"] for l in open(path) if l.strip()}


# ------------------------------------------------------------------ calibration

def one_call_answer(t, facts):
    sysm = "Answer the decision question from the facts given. Return JSON only: {\"answer\": \"<one option, exactly as written>\"}."
    user = (problem_text(t) + "\n\nFacts:\n" + "\n".join("- " + f for f in facts))
    return norm_answer(ask_json(sysm, user, SV.AGENT_MODELS).get("answer"), t["possible_answers"])


def calibrate(args):
    tasks = load_tasks()
    out = os.path.join(RUNS, "calibration.jsonl")
    os.makedirs(RUNS, exist_ok=True)
    have = done_keys(out)

    def job(t):
        key = t["name"]
        if key in have:
            return
        full = one_call_answer(t, t["shared_information"] + t["hidden_information"])
        shared = one_call_answer(t, t["shared_information"])
        append(out, {"key": key, "id": t["id"], "correct": t["correct_answer"], "full": full, "shared": shared})
        SV.log(f"calibrate {key}: full={full} shared={shared} correct={t['correct_answer']}")

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(job, tasks))
    rows = [json.loads(l) for l in open(out)]
    keep = [r for r in rows if r["full"] == r["correct"] and r["shared"] != r["correct"]]
    print(f"tasks {len(rows)} | full-info correct {sum(r['full'] == r['correct'] for r in rows)} | "
          f"shared-only correct {sum(r['shared'] == r['correct'] for r in rows)} | usable (full right, shared wrong) {len(keep)}")


def usable_tasks(n):
    rows = [json.loads(l) for l in open(os.path.join(RUNS, "calibration.jsonl"))]
    keep = {r["key"] for r in rows if r["full"] == r["correct"] and r["shared"] != r["correct"]}
    tasks = [t for t in load_tasks() if t["name"] in keep]
    random.Random(0).shuffle(tasks)
    return tasks[:n]


# ------------------------------------------------------------------ simulated people

PERSONA_SYSTEM = """You are {name}. {scenario}

You are one of four people ({people}) who must make this decision together. Each of you talks privately with your own AI assistant; you cannot talk to the other three directly.

What you know (you do not know what the others know):
{facts}

Have a natural working conversation with your assistant to reach the best decision. Think out loud, bring up what you know when it is relevant, ask questions, and react to what your assistant tells you. Do not paste your whole list at once. Write only your next message to your assistant: one to three sentences, plain words."""


def persona_contents(S, pane):
    """The persona's view of its own chat: its messages are model turns, the assistant's are user turns."""
    turns = [("user", "(Your assistant is ready. Write your first message.)")]
    for e in S.conv(pane):
        if e.get("status") in ("pending", "error"):
            continue
        role = "model" if e["type"] == "user" else "user"
        if turns[-1][0] == role:
            turns[-1] = (role, turns[-1][1] + "\n\n" + e["text"])
        else:
            turns.append((role, e["text"]))
    if turns[-1][0] == "model":
        turns.append(("user", "(Your assistant is waiting for your next message.)"))
    return [SV.turn(r, x) for r, x in turns]


def persona_message(S, pane, persona_sys):
    _, text, _ = SV.llm(persona_sys, persona_contents(S, pane), PERSONA_MODELS, max_tokens=300)
    return text.strip()[:1500]


def persona_answer(S, pane, persona_sys, t):
    convo = "\n".join(f'{"You" if e["type"] == "user" else "Assistant"}: {e["text"]}' for e in S.conv(pane)
                      if e.get("status") not in ("pending", "error"))
    user = (f"Your conversation so far:\n{convo}\n\nPrivately, which option do you choose now? "
            f"Options: {', '.join(t['possible_answers'])}. Return JSON only: {{\"answer\": \"<option>\"}}")
    return norm_answer(ask_json(persona_sys, user, PERSONA_MODELS).get("answer"), t["possible_answers"])


# ------------------------------------------------------------------ one session

def run_session(t, arm, seed, run_dir):
    n = len(NAMES)
    panes = [chr(ord("A") + i) for i in range(n)]
    sess_dir = os.path.join(run_dir, "sessions")
    os.makedirs(sess_dir, exist_ok=True)
    S = SV.State(panes, f"{t['name']}__{arm}__s{seed}", sess_dir=sess_dir)
    if S.events:                                   # stale partial session from an interrupted run
        os.remove(S.path)
        S = SV.State(panes, f"{t['name']}__{arm}__s{seed}", sess_dir=sess_dir)
    hidden = t["hidden_information"]
    slices = {p: [h for j, h in enumerate(hidden) if j % n == i] for i, p in enumerate(panes)}
    for i, p in enumerate(panes):
        S.add({"type": "name", "pane": p, "name": NAMES[i]})
    S.add({"type": "problem", "text": problem_text(t)})
    S.add({"type": "settings", "settings": {"mode": "isolated" if arm in ("isolated", "full") else arm}})
    rng = random.Random(f"{t['name']}-{seed}")
    facts = {}
    for i, p in enumerate(panes):
        mine = (t["shared_information"] + hidden) if arm == "full" else (t["shared_information"] + slices[p])
        mine = mine[:]
        rng.shuffle(mine)
        facts[p] = mine
    persona_sys = {p: PERSONA_SYSTEM.format(name=NAMES[i], scenario=t["description"].strip(),
                                            people=", ".join(NAMES), facts="\n".join("- " + f for f in facts[p]))
                   for i, p in enumerate(panes)}
    order_rng = random.Random(f"order-{t['name']}-{seed}")       # identical across arms
    answers, t0 = {}, time.time()
    for r in range(1, ROUNDS + 1):
        order = panes[:]
        order_rng.shuffle(order)
        for p in order:
            SV.handle_send(S, p, persona_message(S, p, persona_sys[p]))
        if r in ANSWER_AT:
            answers[r] = {p: persona_answer(S, p, persona_sys[p], t) for p in panes}
    rec = {"task": t["name"], "arm": arm, "seed": seed, "correct": t["correct_answer"], "answers": answers,
           "slices": slices, "secs": round(time.time() - t0, 1), "session": S.path}
    rec.update(session_stats(S, panes))
    if arm in ("context", "workspace"):
        rec["funnel"] = clue_funnel(S, panes, slices)
    return rec


def session_stats(S, panes):
    agents = [e for e in S.events if e["type"] == "agent"]
    rets = [e for e in S.events if e["type"] == "retrieval"]
    return {"replies": len(agents), "reply_errors": sum(e.get("status") == "error" for e in agents),
            "reply_secs": [e.get("secs") for e in agents],
            "select_secs": [e["secs"] for e in rets], "select_status": [e["status"] for e in rets],
            "picks": sum(len(e["inform"]) for e in rets), "asks": sum(1 for e in rets if e["ask"])}


JUDGE_SYSTEM = """You audit a group session. Four people each talked privately with their own AI assistant. Each person privately held one or more facts. For each fact, report from the transcripts:
- holder_said: did the holder state the content of this fact in their own messages? (true/false)
- reached: names of OTHER people whose assistant conveyed this fact's content to them (empty list if none)
- correctly_attributed: the subset of 'reached' where the assistant credited the fact to the holder by name
- misattributed: names of people whose assistant credited this fact to someone other than the holder
Judge content, not wording. Return JSON only: {"facts": [{"fact": <index>, "holder_said": bool, "reached": [names], "correctly_attributed": [names], "misattributed": [names]}]}"""


def clue_funnel(S, panes, slices):
    facts = [(h, S.names[p]) for p in panes for h in slices[p]]
    convo = []
    for p in panes:
        convo.append(f"=== {S.names[p]}'s private conversation")
        for e in S.conv(p):
            if e.get("status") not in ("pending", "error"):
                convo.append(f'{S.names[p] if e["type"] == "user" else S.names[p] + "s assistant"}: {e["text"]}')
    user = ("FACTS\n" + "\n".join(f"{i}. (held by {who}) {h}" for i, (h, who) in enumerate(facts))
            + "\n\nTRANSCRIPTS\n" + "\n".join(convo))
    try:
        d = ask_json(JUDGE_SYSTEM, user, JUDGE_MODELS, max_tokens=1500)
        return {"facts": len(facts), "items": d.get("facts", [])}
    except Exception as e:                              # noqa: BLE001
        return {"facts": len(facts), "error": str(e)[:200]}


# ------------------------------------------------------------------ irrelevance probes

PROBES = ["Hello", "Im think dogs are cats", "What's the weather going to be like later?", "Can you remind me how you work?",
          "Sorry, I was away for a minute.", "Tell me a joke.", "ok", "What time is it?",
          "I need a coffee before we start.", "Is this thing on?"]


def probe(arm, i, run_dir):
    sess_dir = os.path.join(run_dir, "sessions")
    os.makedirs(sess_dir, exist_ok=True)
    S = SV.State(["A", "B"], f"probe__{arm}__{i}", sess_dir=sess_dir)
    if S.events:
        os.remove(S.path)
        S = SV.State(["A", "B"], f"probe__{arm}__{i}", sess_dir=sess_dir)
    S.add({"type": "name", "pane": "A", "name": "Alex"})
    S.add({"type": "name", "pane": "B", "name": "Sam"})
    S.add({"type": "settings", "settings": {"mode": arm}})
    S.add({"type": "problem", "text": "Choose a venue for the lab retreat: Lakeside Lodge or Hill House."})
    SV.handle_send(S, "B", "I called Lakeside Lodge this morning: they are fully booked for the whole of May.")
    SV.handle_send(S, "A", PROBES[i])
    reply = [e for e in S.conv("A") if e["type"] == "agent"][-1]["text"]
    mentions = bool(re.search(r"\bSam\b|fully booked|(is|are|was|were) booked", reply, re.I))
    return {"key": f"probe|{arm}|{i}", "probe": PROBES[i], "arm": arm, "mentions_other": mentions, "reply": reply}


# ------------------------------------------------------------------ run + report

def run(args):
    run_dir = os.path.join(RUNS, args.run)
    os.makedirs(run_dir, exist_ok=True)
    out = os.path.join(run_dir, "results.jsonl")
    have = done_keys(out)
    tasks = usable_tasks(args.tasks)
    jobs = []
    for t in tasks:
        for seed in range(args.seeds):
            for arm in ("context", "workspace"):
                jobs.append((t, arm, seed))
        jobs.append((t, "isolated", 0))
        jobs.append((t, "full", 0))
    jobs = [j for j in jobs if f"{j[0]['name']}|{j[1]}|{j[2]}" not in have]
    probes = [(arm, i) for arm in ("context", "workspace") for i in range(len(PROBES))
              if f"probe|{arm}|{i}" not in have]
    SV.log(f"run {args.run}: {len(tasks)} tasks, {len(jobs)} sessions and {len(probes)} probes to do, {args.workers} workers")

    def sjob(j):
        t, arm, seed = j
        try:
            rec = run_session(t, arm, seed, run_dir)
            rec["key"] = f"{t['name']}|{arm}|{seed}"
            append(out, rec)
            acc = {r: sum(a == t["correct_answer"] for a in v.values()) for r, v in rec["answers"].items()}
            SV.log(f"DONE {rec['key']} correct@3={acc.get(3)}/4 correct@6={acc.get(6)}/4 {rec['secs']}s")
        except Exception as e:                          # noqa: BLE001
            SV.log(f"FAILED {t['name']}|{arm}|{seed}: {e!r}")

    def pjob(pr):
        try:
            append(out, probe(pr[0], pr[1], run_dir))
        except Exception as e:                          # noqa: BLE001
            SV.log(f"FAILED probe {pr}: {e!r}")

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(pjob, probes))
        list(ex.map(sjob, jobs))
    SV.log("run finished")


def perm_test(diffs, iters=20000, seed=0):
    """One-sided paired sign-flip permutation test of mean(diffs) > 0."""
    if not diffs:
        return None
    rng = random.Random(seed)
    obs = sum(diffs) / len(diffs)
    hits = sum(1 for _ in range(iters) if sum(d if rng.random() < .5 else -d for d in diffs) / len(diffs) >= obs - 1e-12)
    return hits / iters


def report(args):
    run_dir = os.path.join(RUNS, args.run)
    rows = [json.loads(l) for l in open(os.path.join(run_dir, "results.jsonl")) if l.strip()]
    sess = [r for r in rows if not r["key"].startswith("probe|")]
    probes = [r for r in rows if r["key"].startswith("probe|")]

    def acc(r, k):
        a = r["answers"].get(str(k)) or r["answers"].get(k) or {}
        return sum(v == r["correct"] for v in a.values()) / max(1, len(a))

    def group(r):
        a = r["answers"].get(str(6)) or r["answers"].get(6) or {}
        return float(all(v == r["correct"] for v in a.values()) and len(a) > 0)

    lines = ["| arm | sessions | individual acc @3 | individual acc @6 | all four correct @6 | fact reached others | misattributed | select timeouts |",
             "|---|---|---|---|---|---|---|---|"]
    by_arm = {}
    for arm in ("isolated", "context", "workspace", "full"):
        rs = [r for r in sess if r["arm"] == arm]
        by_arm[arm] = rs
        if not rs:
            continue
        reach = mis = tot = 0
        for r in rs:
            f = r.get("funnel") or {}
            for it in f.get("items", []):
                tot += 1
                reach += bool(it.get("reached"))
                mis += bool(it.get("misattributed"))
        to = sum(s == "timeout" for r in rs for s in r.get("select_status", []))
        nsel = sum(len(r.get("select_status", [])) for r in rs)
        mean = lambda xs: sum(xs) / len(xs)
        lines.append(f"| {arm} | {len(rs)} | {mean([acc(r, 3) for r in rs]):.2f} | {mean([acc(r, 6) for r in rs]):.2f} | "
                     f"{mean([group(r) for r in rs]):.2f} | {f'{reach}/{tot}' if tot else '-'} | {f'{mis}/{tot}' if tot else '-'} | "
                     f"{f'{to}/{nsel}' if nsel else '-'} |")
    ctx = {(r["task"], r["seed"]): r for r in by_arm.get("context", [])}
    wsp = {(r["task"], r["seed"]): r for r in by_arm.get("workspace", [])}
    pairs = sorted(set(ctx) & set(wsp))
    diffs = [acc(wsp[k], 6) - acc(ctx[k], 6) for k in pairs]
    p = perm_test(diffs)
    irr = {arm: [r["mentions_other"] for r in probes if r["arm"] == arm] for arm in ("context", "workspace")}
    irr_rate = {arm: (sum(v) / len(v) if v else None) for arm, v in irr.items()}
    d = sum(diffs) / len(diffs) if diffs else None
    floor = by_arm.get("isolated") and sum(acc(r, 6) for r in by_arm["isolated"]) / len(by_arm["isolated"])
    ceil = by_arm.get("full") and sum(acc(r, 6) for r in by_arm["full"]) / len(by_arm["full"])
    verdict = "insufficient data"
    if floor is not None and ceil is not None and ceil - floor < 0.30:
        verdict = f"STOP: no headroom (full {ceil:.2f} - isolated {floor:.2f} < 0.30)"
    elif d is not None and p is not None:
        if d >= 0.15 and p < 0.05:
            verdict = "ADOPT workspace (accuracy)"
        elif abs(d) <= 0.05 and irr_rate["context"] is not None and irr_rate["context"] >= 0.20 and irr_rate["workspace"] <= 0.05:
            verdict = "ADOPT workspace (as a gate against irrelevant mentions, not an accuracy gain)"
        else:
            verdict = "SHIP context (workspace did not meet the pre-registered rule)"
    lines += ["", f"paired sessions: {len(pairs)} | workspace - context, individual acc @6: "
              + (f"{d:+.3f}, one-sided permutation p = {p:.3f}" if d is not None else "n/a"),
              f"irrelevant-mention rate (probes): context {irr_rate['context']}, workspace {irr_rate['workspace']}",
              f"decision: {verdict}"]
    text = "\n".join(lines)
    open(os.path.join(run_dir, "summary.md"), "w").write(text + "\n")
    print(text)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("calibrate"); c.add_argument("--workers", type=int, default=8)
    r = sub.add_parser("run"); r.add_argument("--run", default="main"); r.add_argument("--tasks", type=int, default=12)
    r.add_argument("--seeds", type=int, default=2); r.add_argument("--workers", type=int, default=4)
    q = sub.add_parser("report"); q.add_argument("--run", default="main")
    a = ap.parse_args()
    {"calibrate": calibrate, "run": run, "report": report}[a.cmd](a)


if __name__ == "__main__":
    main()
