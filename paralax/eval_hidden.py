#!/usr/bin/env python3
"""
Does Paralax help a group decide better than independent assistant pairs?

Benchmark: HiddenBench (Li, Naito & Shirado, ICML 2026; arXiv 2505.11556; data at
huggingface.co/datasets/YuxuanLi1225/HiddenBench, MIT licence). 65 group-decision tasks. The
facts everyone shares point to a decoy option; the hidden facts, dealt one per person, point to
the right one. The answer is one option, judged by exact match.

Protocol (what the user asked for):
  * N simulated people (default 5) are flash-lite. Each gets the scenario, the shared facts and
    their own hidden slice. Each talks only to their own assistant and must describe the
    problem in their own words: the assistants and the workspace are never given it.
  * The assistants and the workspace selection are flash (set via PARALAX_MODELS and
    PARALAX_SELECT_MODELS; the run script below sets them).
  * Turns within a round run concurrently, as people really type. After the last round each
    person privately answers; the group answer is the plurality (ties count as wrong).

Arms (the server's modes, through the shipped handle_send):
  isolated    N independent assistant pairs, no shared workspace            (the control)
  workspace   Paralax: background selection from the shared workspace       (the proposal)
  context     every other person's turns in the reply prompt, same rules    (strong baseline)
  full        isolated, but every person holds every fact                   (pipeline ceiling)

    PARALAX_ENV=... PARALAX_MODELS=gemini-3.5-flash,gemini-3.8-flash \
    PARALAX_SELECT_MODELS=gemini-3.5-flash,gemini-3.8-flash PARALAX_SELECT_CAP_SECS=30 \
    PARALAX_SELECT_HEDGE_SECS=8 python3 eval_hidden.py run --run v1 --tasks 12 --seeds 2
    python3 eval_hidden.py report --run v1

Results append to eval/runs/<run>/results.jsonl (resumable); sessions are kept for analysis.
"""
import argparse, json, os, random, re, threading, time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import server as SV
import workspace as W

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "eval", "data", "benchmark.json")
RUNS = os.path.join(HERE, "eval", "runs")
DATA_URL = "https://huggingface.co/datasets/YuxuanLi1225/HiddenBench/resolve/main/benchmark.json"
# A research department: the simulated people differ in role, comprehension, confidence and in
# how readily they volunteer what they know. Seat i always gets PERSONAS[i], so arms are matched.
PERSONAS = [
    {"name": "Alex", "role": "professor and head of the group",
     "character": "You think in big pictures and decide fast. You form a view early, state it with confidence and defend it; you dislike being slowed down by details. You readily share opinions but tend to treat the facts you hold as obvious and not worth spelling out. When facts are laid out plainly you synthesise them well."},
    {"name": "Sam", "role": "postdoc",
     "character": "You are methodical and evidence-first. You keep a careful mental ledger of what is known versus assumed, you ask where a claim comes from, and you state your own facts precisely. You are slow to commit and comfortable saying the evidence is not yet enough."},
    {"name": "Robin", "role": "first-year PhD student",
     "character": "You are eager but unsure of yourself. You do not always see what a fact implies unless someone spells it out, you defer to senior people, and you ask a lot of questions. You often forget to mention what you know unless you are asked about it directly."},
    {"name": "Jordan", "role": "lab manager",
     "character": "You are practical and concrete: logistics, access, supplies, timing. You read things literally and are weak on abstract inference, but strong on operational facts. You write tersely and volunteer a fact only when it seems directly relevant to the practical side."},
    {"name": "Casey", "role": "visiting researcher from another field",
     "character": "You reason well but use the vocabulary of your own field, sometimes misread this domain's terms, and reach for analogies. You are talkative and open, happy to say what you know, but you occasionally misjudge how important a fact is."},
    {"name": "Morgan", "role": "research software engineer",
     "character": "You want a clear decision rule and a checklist of criteria, and you weigh trade-offs systematically. You are mild-mannered, concise, and share facts when they fit a criterion you are evaluating."},
    {"name": "Taylor", "role": "master's intern",
     "character": "You have little background, you are anxious about getting it wrong, and you write very short messages. You often say you are not sure, and you mention what you know hesitantly."},
    {"name": "Riley", "role": "emeritus professor",
     "character": "You are wise but tangential: you tell stories, draw on past cases and strong priors, and take a while to get to the point. You share what you know embedded in anecdotes."},
]
NAMES = [p["name"] for p in PERSONAS]
HUMAN_MODELS = [m for m in os.environ.get("PARALAX_HUMAN_MODELS", "gemini-3.5-flash-lite").split(",") if m]
JUDGE_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"]
_write = threading.Lock()


def load_tasks():
    if not os.path.exists(DATA):
        import urllib.request
        os.makedirs(os.path.dirname(DATA), exist_ok=True)
        urllib.request.urlretrieve(DATA_URL, DATA)
    return json.load(open(DATA))


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


def question(t):
    return "Which option should the group choose: " + ", ".join(t["possible_answers"]) + "?"


# ------------------------------------------------------------------ calibration (one call, the humans' model)

def one_call_answer(t, facts, models):
    sysm = 'Answer the decision question from the facts given. Return JSON only: {"answer": "<one option, exactly as written>"}.'
    user = t["description"].strip() + "\n\n" + question(t) + "\n\nFacts:\n" + "\n".join("- " + f for f in facts)
    return norm_answer(ask_json(sysm, user, models).get("answer"), t["possible_answers"])


def calibrate(args):
    tasks = load_tasks()
    models = [args.model] if args.model else HUMAN_MODELS
    out = os.path.join(RUNS, f"calibration_{models[0]}.jsonl")
    os.makedirs(RUNS, exist_ok=True)
    have = done_keys(out)

    def job(t):
        if t["name"] in have:
            return
        full = one_call_answer(t, t["shared_information"] + t["hidden_information"], models)
        shared = one_call_answer(t, t["shared_information"], models)
        append(out, {"key": t["name"], "id": t["id"], "correct": t["correct_answer"], "full": full, "shared": shared})

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(job, tasks))
    rows = [json.loads(l) for l in open(out)]
    keep = [r for r in rows if r["full"] == r["correct"] and r["shared"] != r["correct"]]
    print(f"{models[0]}: tasks {len(rows)} | full-info correct {sum(r['full'] == r['correct'] for r in rows)} | "
          f"shared-only correct {sum(r['shared'] == r['correct'] for r in rows)} | usable {len(keep)}")


def usable_tasks(n, model):
    path = os.path.join(RUNS, f"calibration_{model}.jsonl")
    rows = [json.loads(l) for l in open(path)]
    keep = {r["key"] for r in rows if r["full"] == r["correct"] and r["shared"] != r["correct"]}
    tasks = [t for t in load_tasks() if t["name"] in keep]
    random.Random(0).shuffle(tasks)
    return tasks[:n]


# ------------------------------------------------------------------ simulated people (flash-lite)

PERSONA_SYSTEM = """You are {name}, {role} in an academic research department. {character}

The situation: {scenario}

You are one of {n} people ({people}) who must make this decision together. Each of you talks privately with your own AI assistant; you cannot talk to the other people directly, and you do not know what they know.

What you know:
{facts}

Your assistant knows nothing about this situation until you tell it. In your first message, describe the decision in your own words: the situation, the options, and what you have to decide. After that, have a natural working conversation in character: bring up what you know when it is relevant to you, ask questions, and react to what your assistant tells you. Do not paste your whole list at once. Write only your next message to your assistant, at most four sentences, in your own voice."""


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
    _, text, _ = SV.llm(persona_sys, persona_contents(S, pane), HUMAN_MODELS, max_tokens=300)
    return text.strip()[:1500]


def persona_answer(S, pane, persona_sys, t):
    convo = "\n".join(f'{"You" if e["type"] == "user" else "Assistant"}: {e["text"]}' for e in S.conv(pane)
                      if e.get("status") not in ("pending", "error"))
    user = (f"Your conversation so far:\n{convo}\n\nPrivately, which option do you choose now? "
            f"Options: {', '.join(t['possible_answers'])}. Return JSON only: {{\"answer\": \"<option>\"}}")
    try:
        return norm_answer(ask_json(persona_sys, user, HUMAN_MODELS).get("answer"), t["possible_answers"])
    except Exception:                                   # noqa: BLE001
        return None


# ------------------------------------------------------------------ one session

def fresh_state(panes, name, run_dir):
    sess_dir = os.path.join(run_dir, "sessions")
    os.makedirs(sess_dir, exist_ok=True)
    S = SV.State(panes, name, sess_dir=sess_dir)
    if S.events:                                        # partial session from an interrupted run
        os.remove(S.path)
        S = SV.State(panes, name, sess_dir=sess_dir)
    return S


def run_session(t, arm, seed, n, rounds, run_dir):
    panes = [chr(ord("A") + i) for i in range(n)]
    S = fresh_state(panes, f"{t['name']}__{arm}__s{seed}", run_dir)
    hidden = t["hidden_information"]
    slices = {p: [h for j, h in enumerate(hidden) if j % n == i] for i, p in enumerate(panes)}
    for i, p in enumerate(panes):
        S.add({"type": "name", "pane": p, "name": NAMES[i]})
    S.add({"type": "settings", "settings": {"mode": "isolated" if arm in ("isolated", "full") else arm}})
    # the problem is never written into the shared field: each person describes it in their own words
    rng = random.Random(f"{t['name']}-{seed}")
    persona_sys = {}
    for i, p in enumerate(panes):
        mine = (t["shared_information"] + hidden) if arm == "full" else (t["shared_information"] + slices[p])
        mine = mine[:]
        rng.shuffle(mine)
        persona_sys[p] = PERSONA_SYSTEM.format(name=NAMES[i], role=PERSONAS[i]["role"], character=PERSONAS[i]["character"],
                                               scenario=t["description"].strip(), n=n,
                                               people=", ".join(f"{q['name']} ({q['role']})" for q in PERSONAS[:n]),
                                               facts="\n".join("- " + f for f in mine))
    stagger = random.Random(f"stagger-{t['name']}-{seed}")
    t0 = time.time()
    answers = {}

    def one_turn(p, delay):
        time.sleep(delay)
        SV.handle_send(S, p, persona_message(S, p, persona_sys[p]))

    for r in range(1, rounds + 1):
        delays = {p: stagger.uniform(0, 3.0) for p in panes}      # people do not all type at once
        with ThreadPoolExecutor(n) as ex:
            list(ex.map(lambda p: one_turn(p, delays[p]), panes))
        if r in (max(1, rounds // 2), rounds):
            with ThreadPoolExecutor(n) as ex:
                answers[r] = dict(zip(panes, ex.map(lambda p: persona_answer(S, p, persona_sys[p], t), panes)))
    rec = {"task": t["name"], "arm": arm, "seed": seed, "n": n, "rounds": rounds, "version": W.VERSION,
           "correct": t["correct_answer"], "answers": answers, "slices": slices,
           "secs": round(time.time() - t0, 1), "session": os.path.relpath(S.path, os.path.join(HERE, "eval"))}
    rec.update(session_stats(S))
    if arm != "full":
        rec["funnel"] = clue_funnel(S, panes, slices)
    return rec


def session_stats(S):
    agents = [e for e in S.events if e["type"] == "agent"]
    rets = [e for e in S.events if e["type"] == "retrieval"]
    return {"replies": len(agents), "reply_errors": sum(e.get("status") == "error" for e in agents),
            "reply_secs": round(sum(e.get("secs") or 0 for e in agents) / max(1, len(agents)), 1),
            "select_secs": round(sum(e["secs"] for e in rets) / max(1, len(rets)), 2) if rets else None,
            "select_status": dict(Counter(e["status"] for e in rets)),
            "picks": sum(len(e["inform"]) for e in rets), "asks": sum(1 for e in rets if e["ask"]),
            "relations": dict(Counter(x["relation"] for e in rets for x in e["inform"])),
            "assistant_calls": len(agents) + len(rets)}


JUDGE_SYSTEM = """You audit a group session. Several people each talked privately with their own AI assistant. Each person privately held one or more facts (listed with the holder's name). For each fact, report from the transcripts:
- holder_said: did the holder state the content of this fact in their own messages? (true/false)
- holder_turns: the turn numbers (the #numbers on the holder's own messages) where the holder stated it; empty list if never
- reached: names of OTHER people whose assistant conveyed this fact's content to them (empty list if none)
- correctly_attributed: the subset of "reached" where the assistant credited the fact to the holder by name
- misattributed: names of people whose assistant credited this fact to someone other than the holder
Judge content, not wording. Return JSON only: {"facts": [{"fact": <index>, "holder_said": bool, "holder_turns": [numbers], "reached": [names], "correctly_attributed": [names], "misattributed": [names]}]}"""


def clue_funnel(S, panes, slices):
    facts = [(h, S.names[p]) for p in panes for h in slices[p]]
    if not facts:
        return {"facts": 0, "items": []}
    convo = []
    for p in panes:
        convo.append(f"=== {S.names[p]}'s private conversation")
        for e in S.conv(p):
            if e.get("status") not in ("pending", "error"):
                who = f'#{e["id"]} {S.names[p]}' if e["type"] == "user" else f'{S.names[p]}\'s assistant'
                convo.append(f'{who}: {e["text"]}')
    user = ("FACTS\n" + "\n".join(f"{i}. (held by {who}) {h}" for i, (h, who) in enumerate(facts))
            + "\n\nTRANSCRIPTS\n" + "\n".join(convo))
    try:
        d = ask_json(JUDGE_SYSTEM, user, JUDGE_MODELS, max_tokens=2000)
        return {"facts": len(facts), "items": d.get("facts", [])}
    except Exception as e:                              # noqa: BLE001
        return {"facts": len(facts), "error": str(e)[:200]}


# ------------------------------------------------------------------ run + report

def run(args):
    run_dir = os.path.join(RUNS, args.run)
    os.makedirs(run_dir, exist_ok=True)
    out = os.path.join(run_dir, "results.jsonl")
    have = done_keys(out)
    tasks = usable_tasks(args.tasks, HUMAN_MODELS[0])
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    jobs = []
    for t in tasks:
        for arm in arms:
            for seed in range(args.seeds if arm in ("isolated", "workspace", "context") else 1):
                if f"{t['name']}|{arm}|{seed}" not in have:
                    jobs.append((t, arm, seed))
    json.dump({"version": W.VERSION, "arms": arms, "tasks": [t["name"] for t in tasks], "n": args.people, "rounds": args.rounds,
               "seeds": args.seeds, "human_models": HUMAN_MODELS, "agent_models": SV.AGENT_MODELS,
               "select_models": SV.SELECT_MODELS, "select_cap": SV.SELECT_CAP_SECS, "started": time.strftime("%Y-%m-%d %H:%M")},
              open(os.path.join(run_dir, "config.json"), "w"), indent=1)
    SV.log(f"run {args.run} ({W.VERSION}): {len(tasks)} tasks, {len(jobs)} sessions to do, {args.workers} workers, "
           f"humans={HUMAN_MODELS} assistants={SV.AGENT_MODELS} select={SV.SELECT_MODELS}")

    def job(j):
        t, arm, seed = j
        try:
            rec = run_session(t, arm, seed, args.people, args.rounds, run_dir)
            rec["key"] = f"{t['name']}|{arm}|{seed}"
            append(out, rec)
            fin = rec["answers"][args.rounds]
            SV.log(f"DONE {rec['key']} final={sum(a == t['correct_answer'] for a in fin.values())}/{args.people} "
                   f"picks={rec['picks']} {rec['secs']}s")
        except Exception as e:                          # noqa: BLE001
            SV.log(f"FAILED {t['name']}|{arm}|{seed}: {e!r}")

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(job, jobs))
    SV.log("run finished")


def perm_test(diffs, iters=20000, seed=0):
    """One-sided paired sign-flip permutation test of mean(diffs) > 0."""
    if not diffs:
        return None
    rng = random.Random(seed)
    obs = sum(diffs) / len(diffs)
    hits = sum(1 for _ in range(iters) if sum(d if rng.random() < .5 else -d for d in diffs) / len(diffs) >= obs - 1e-12)
    return hits / iters


def final_round(r):
    return max(int(k) for k in r["answers"])


def ind_acc(r, k=None):
    k = k or final_round(r)
    a = r["answers"].get(str(k)) or r["answers"].get(k) or {}
    return sum(v == r["correct"] for v in a.values()) / max(1, len(a))


def plurality(r):
    a = r["answers"].get(str(final_round(r))) or r["answers"].get(final_round(r)) or {}
    c = Counter(v for v in a.values() if v)
    if not c:
        return 0.0
    top = c.most_common()
    if len(top) > 1 and top[0][1] == top[1][1]:
        return 0.0
    return float(top[0][0] == r["correct"])


def report(args):
    run_dir = os.path.join(RUNS, args.run)
    rows = [json.loads(l) for l in open(os.path.join(run_dir, "results.jsonl")) if l.strip()]
    mean = lambda xs: sum(xs) / len(xs) if xs else float("nan")
    lines = [f"run {args.run} | algorithm {sorted(set(r['version'] for r in rows))} | sessions {len(rows)}", "",
             "| arm | sessions | individual acc (mid) | individual acc (final) | plurality correct | holder said fact | fact reached another person | credited to holder | misattributed | assistant calls / session |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    by_arm = {}
    for arm in ("isolated", "context", "workspace", "full"):
        rs = [r for r in rows if r["arm"] == arm]
        by_arm[arm] = rs
        if not rs:
            continue
        said = reach = cred = mis = tot = 0
        for r in rs:
            for it in (r.get("funnel") or {}).get("items", []):
                tot += 1
                said += bool(it.get("holder_said"))
                reach += bool(it.get("reached"))
                cred += bool(it.get("correctly_attributed"))
                mis += bool(it.get("misattributed"))
        mid = [ind_acc(r, max(1, r["rounds"] // 2)) for r in rs]
        f = lambda x: f"{x}/{tot}" if tot else "-"
        lines.append(f"| {arm} | {len(rs)} | {mean(mid):.2f} | {mean([ind_acc(r) for r in rs]):.2f} | {mean([plurality(r) for r in rs]):.2f} | "
                     f"{f(said)} | {f(reach)} | {f(cred)} | {f(mis)} | {mean([r['assistant_calls'] for r in rs]):.0f} |")

    def paired(a, b):
        A = {(r["task"], r["seed"]): r for r in by_arm.get(a, [])}
        B = {(r["task"], r["seed"]): r for r in by_arm.get(b, [])}
        keys = sorted(set(A) & set(B))
        d = [ind_acc(A[k]) - ind_acc(B[k]) for k in keys]
        g = [plurality(A[k]) - plurality(B[k]) for k in keys]
        return keys, d, g

    lines.append("")
    for a, b in (("workspace", "isolated"), ("workspace", "context"), ("context", "isolated")):
        keys, d, g = paired(a, b)
        if keys:
            lines.append(f"{a} - {b}: {len(keys)} paired sessions | individual acc {mean(d):+.3f} (one-sided p = {perm_test(d):.3f}) "
                         f"| plurality {mean(g):+.3f} (p = {perm_test(g):.3f})")
    # noise: same arm, seed 0 vs seed 1
    for arm in ("isolated", "workspace", "context"):
        s0 = {r["task"]: r for r in by_arm.get(arm, []) if r["seed"] == 0}
        s1 = {r["task"]: r for r in by_arm.get(arm, []) if r["seed"] == 1}
        ks = sorted(set(s0) & set(s1))
        if ks:
            d = [abs(ind_acc(s0[k]) - ind_acc(s1[k])) for k in ks]
            lines.append(f"noise {arm}: mean |seed0 - seed1| individual acc = {mean(d):.3f} over {len(ks)} tasks")
    ws = by_arm.get("workspace", [])
    if ws:
        st = Counter()
        for r in ws:
            st.update(r.get("select_status", {}))
        rel = Counter()
        for r in ws:
            rel.update(r.get("relations", {}))
        lines.append(f"workspace selection: status {dict(st)} | relations {dict(rel)} | picks/session {mean([r['picks'] for r in ws]):.1f} | asks/session {mean([r['asks'] for r in ws]):.1f}")
    text = "\n".join(lines)
    open(os.path.join(run_dir, "summary.md"), "w").write(text + "\n")
    print(text)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("calibrate"); c.add_argument("--workers", type=int, default=8); c.add_argument("--model", default=None)
    r = sub.add_parser("run"); r.add_argument("--run", required=True); r.add_argument("--tasks", type=int, default=12)
    r.add_argument("--seeds", type=int, default=2); r.add_argument("--workers", type=int, default=3)
    r.add_argument("--people", type=int, default=5); r.add_argument("--rounds", type=int, default=6)
    r.add_argument("--arms", default="isolated,workspace,context,full")
    q = sub.add_parser("report"); q.add_argument("--run", required=True)
    a = ap.parse_args()
    {"calibrate": calibrate, "run": run, "report": report}[a.cmd](a)


if __name__ == "__main__":
    main()
