#!/usr/bin/env python3
"""
Paralax: N people work on one problem, each with their own assistant, and every assistant
reads every conversation.

Each person talks only with their own assistant, and each assistant replies only to its own
person. Every assistant also reads all the other conversations, live, and a shared board that
an integrator rewrites after each turn. The integrator can also hand one person's assistant a
short unprompted note when another person's work changes what that person should do next.

This is a blackboard architecture. The assistants are the knowledge sources, the board is the
shared representation, and the integrator is the control that keeps the board current and
routes notes.

Python 3.9+ standard library only. Needs one Gemini API key.

    GEMINI_API_KEY=... python3 paralax/server.py            # http://localhost:8808/
    python3 paralax/server.py --host 0.0.0.0                # let a second laptop join
    python3 paralax/server.py --new                         # fresh session
    python3 paralax/server.py --panes 3                     # three people
"""
import argparse, glob, itertools, json, os, queue, re, threading, time
import urllib.error, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
SESS_DIR = os.path.join(HERE, "sessions")
os.makedirs(SESS_DIR, exist_ok=True)


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ------------------------------------------------------------------ keys and models

KEY_VARS = ("GEMINI_API_KEY_POOL", "GEMINI_API_KEYS", "GEMINI_API_KEY", "GOOGLE_API_KEY")


def load_keys():
    """Keys from the environment, then from $PARALAX_ENV, then from paralax/.env (gitignored)."""
    keys = []

    def add(s):
        for k in re.split(r"[,\s]+", s.strip().strip('"\'')):
            k = k.strip().strip('"\'')
            if k and k not in keys:
                keys.append(k)

    for v in KEY_VARS:
        if os.environ.get(v):
            add(os.environ[v])
    for f in (os.environ.get("PARALAX_ENV", ""), os.path.join(HERE, ".env")):
        if f and os.path.exists(f):
            for line in open(f):
                m = re.match(r"\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*)", line)
                if m and m.group(1) in KEY_VARS:
                    add(m.group(2))
    return keys


KEYS = load_keys()
DEAD_KEYS = set()
# Model chains, tried in order. Whole replies, not streams: Gemini 3.x streams were observed
# to stop mid-sentence without a finish reason, while whole replies arrive complete in 2-10 s.
AGENT_MODELS = [m.strip() for m in os.environ.get(
    "PARALAX_MODELS", "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",") if m.strip()]
INTEGRATOR_MODELS = [m.strip() for m in os.environ.get(
    "PARALAX_INTEGRATOR_MODELS", "gemini-3.5-flash,gemini-3.8-flash,gemini-3.5-flash-lite").split(",") if m.strip()]
THINKING_BUDGET = int(os.environ.get("PARALAX_THINKING", "0"))      # 0 = no hidden thinking; -1 = model default
ATTEMPT_SECS = float(os.environ.get("PARALAX_ATTEMPT_SECS", "40"))  # give up on one model call after this
HEDGE_SECS = float(os.environ.get("PARALAX_HEDGE_SECS", "6"))       # start the next model if no answer by then
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"

_counter = itertools.count()


def _live_keys():
    return [k for k in KEYS if k not in DEAD_KEYS]


class LLMError(Exception):
    def __init__(self, code, msg):
        super().__init__(f"{code} {msg}")
        self.code = code


def _post(model, key, payload):
    req = urllib.request.Request(ENDPOINT % model, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=ATTEMPT_SECS + 5) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:                                  # noqa: BLE001
            msg = body[:200]
        raise LLMError(e.code, msg) from None


def _call(model, key, system, contents, json_mode, max_tokens):
    """One blocking call. Returns the reply text or raises LLMError."""
    gen = {"maxOutputTokens": max_tokens, "temperature": 0.3 if json_mode else 0.7}
    if json_mode:
        gen["responseMimeType"] = "application/json"
    if "lite" not in model and THINKING_BUDGET >= 0:
        gen["thinkingConfig"] = {"thinkingBudget": THINKING_BUDGET}
    payload = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents, "generationConfig": gen}
    r = _post(model, key, payload)
    cands = r.get("candidates") or [{}]
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    if not text.strip():
        raise LLMError("empty", f"empty answer (finish={cands[0].get('finishReason')})")
    return text


def _attempt(model, system, contents, json_mode, max_tokens, check):
    """Try one model, rotating keys: a dead key is retired, a rate-limited key is skipped.
    `check` (optional) validates the text and raises ValueError to reject it."""
    last = None
    for _ in range(max(1, len(_live_keys()))):
        keys = _live_keys()
        if not keys:
            raise RuntimeError("No working Gemini API key. Set GEMINI_API_KEY (see paralax/README.md).")
        key = keys[next(_counter) % len(keys)]
        try:
            text = _call(model, key, system, contents, json_mode, max_tokens)
            return text, (check(text) if check else None)
        except LLMError as e:
            last = e
            log(f"llm {model} key..{key[-4:]}: {str(e)[:110]}")
            if e.code in (401, 403) or (e.code == 400 and "API key" in str(e)):
                DEAD_KEYS.add(key)
                log(f"retired key ..{key[-4:]} ({len(_live_keys())} left)")
                continue
            if e.code == 429:
                continue
            raise
    raise last or RuntimeError("no keys")


def llm(system, contents, models, json_mode=False, max_tokens=1500, check=None):
    """Return (model, text, checked). Hedged requests: the first model starts at once; the next
    model starts when the previous one fails or has not answered within HEDGE_SECS; the first
    good answer wins and slower calls are abandoned."""
    results = queue.Queue()

    def run(model):
        try:
            text, checked = _attempt(model, system, contents, json_mode, max_tokens, check)
            results.put((True, model, (text, checked)))
        except Exception as e:                             # noqa: BLE001
            results.put((False, model, e))

    errors, st = [], {"launched": 0, "running": 0, "deadline": 0.0}

    def launch():
        threading.Thread(target=run, args=(models[st["launched"]],), daemon=True).start()
        st["launched"] += 1
        st["running"] += 1
        st["deadline"] = time.time() + ATTEMPT_SECS

    launch()
    while True:
        more = st["launched"] < len(models)
        try:
            ok, model, val = results.get(timeout=max(0.05, HEDGE_SECS if more else st["deadline"] - time.time()))
        except queue.Empty:
            if more:
                log(f"llm {models[st['launched'] - 1]}: no answer in {HEDGE_SECS:.0f}s, also trying {models[st['launched']]}")
                launch()
                continue
            raise RuntimeError(f"no model answered within {ATTEMPT_SECS:.0f}s: " + " | ".join(errors))
        st["running"] -= 1
        if ok:
            return model, val[0], val[1]
        errors.append(f"{model}: {str(val)[:90]}")
        if isinstance(val, ValueError):
            log(f"llm {model}: rejected answer ({str(val)[:80]})")
        if st["running"] == 0:
            if st["launched"] >= len(models):
                raise RuntimeError("all models failed: " + " | ".join(errors))
            launch()                                       # nothing left in flight: next model now


def turn(role, text):
    return {"role": role, "parts": [{"text": text}]}


# ------------------------------------------------------------------ shared state

def default_board():
    return {"headline": "", "summary": "", "established": [], "approaches": [],
            "open_questions": [], "tensions": [], "next": {}, "updated": None}


class State:
    def __init__(self, panes, session):
        self.lock = threading.RLock()
        self.panes = panes
        self.clients = set()                      # one queue per open page (server-sent events)
        self.pane_locks = {p: threading.Lock() for p in panes}
        self.integrator_dirty = threading.Event()
        self._fresh(session)
        self._load()

    def _fresh(self, session):
        self.session = session
        self.path = os.path.join(SESS_DIR, session + ".jsonl")
        self.events = []
        self.next_id = 1
        self.board = default_board()
        self.problem = ""
        self.names = {p: f"Person {p}" for p in self.panes}
        self.settings = {"nudges": True}
        self.busy = {p: False for p in self.panes}
        self.last_integrated_id = 0

    # ---- persistence: one JSON line per durable event
    def _load(self):
        if not os.path.exists(self.path):
            return
        for line in open(self.path):
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            self._apply(e)
            self.events.append(e)
            self.next_id = max(self.next_id, e["id"] + 1)
        self.events.sort(key=lambda e: e["id"])
        self.last_integrated_id = max((e.get("turn", 0) for e in self.events if e["type"] == "board"), default=0)
        log(f"loaded {len(self.events)} events from {self.path}")

    def _persist(self, e):
        with open(self.path, "a") as f:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    def _apply(self, e):
        t = e["type"]
        if t == "problem":
            self.problem = e["text"]
        elif t == "name":
            self.names[e["pane"]] = e["name"]
        elif t == "board":
            self.board = e["board"]
        elif t == "settings":
            self.settings.update(e["settings"])

    # ---- events
    def add(self, e, persist=True):
        with self.lock:
            e["id"] = self.next_id
            self.next_id += 1
            e.setdefault("t", time.time())
            self._apply(e)
            self.events.append(e)
            if persist:
                self._persist(e)
        self.broadcast(e)
        return e

    def finalize(self, e):
        """Persist the final form of an event that was first shown as pending."""
        with self.lock:
            self._persist(e)
        self.broadcast(e)

    def broadcast(self, msg):
        data = json.dumps(msg, ensure_ascii=False)
        with self.lock:
            for q in list(self.clients):
                q.put(data)

    def snapshot(self):
        with self.lock:
            return {"panes": self.panes, "names": self.names, "problem": self.problem,
                    "board": self.board, "settings": self.settings, "busy": self.busy,
                    "events": [e for e in self.events if e["type"] in ("user", "agent", "nudge")],
                    "last_id": self.next_id - 1, "session": self.session,
                    "models": {"agent": AGENT_MODELS, "integrator": INTEGRATOR_MODELS}}

    def reset(self):
        with self.lock:
            self._fresh(time.strftime("%Y%m%d-%H%M%S"))
        self.broadcast({"type": "reset"})

    def conv(self, pane):
        with self.lock:
            return [e for e in self.events if e["type"] in ("user", "agent", "nudge") and e["pane"] == pane]


def ago(t):
    d = max(0, time.time() - t)
    if d < 50:
        return "just now"
    if d < 3600:
        return f"{int(d // 60)} min ago"
    return f"{int(d // 3600)} h ago"


def speaker(S, e):
    name = S.names[e["pane"]]
    if e["type"] == "user":
        return name
    if e["type"] == "nudge":
        return f"{name}'s assistant (unprompted note)"
    return f"{name}'s assistant"


def transcript_text(S, pane, limit=40, new_after=None):
    msgs = S.conv(pane)[-limit:]
    if not msgs:
        return f"({S.names[pane]} has not written anything yet.)"
    lines = []
    for e in msgs:
        if e.get("status") == "pending":
            lines.append(f"[{ago(e['t'])}] {speaker(S, e)}: (composing a reply)")
            continue
        tag = " [NEW]" if new_after is not None and e["id"] > new_after else ""
        lines.append(f"[{ago(e['t'])}] {speaker(S, e)}{tag}: {e['text']}")
    return "\n".join(lines)


def board_text(S):
    b = S.board
    if not b.get("updated"):
        return "(empty: no turn has been integrated yet)"
    out = [f"Summary: {b.get('summary', '')}"]
    sections = [("Established", [f"({x.get('by', '?')}) {x.get('claim', '')}" for x in b.get("established", [])]),
                ("Approaches", [f"{x.get('name', '')} [{x.get('owner', '?')}, {x.get('status', '')}] {x.get('note', '')}"
                                for x in b.get("approaches", [])]),
                ("Open questions", b.get("open_questions", [])),
                ("Tensions", b.get("tensions", [])),
                ("Suggested next moves", [f"{k}: {v}" for k, v in (b.get("next") or {}).items()])]
    for title, items in sections:
        if items:
            out.append(title + ":")
            out += [f"- {x}" for x in items]
    return "\n".join(out)


# ------------------------------------------------------------------ the personal assistant

AGENT_SYSTEM = """You are {name}'s personal assistant in a shared working session.

{n} people ({people}) are working on the same problem at the same time. Each person talks only with their own assistant, and each assistant replies only to its own person. But every assistant, including you, can read all the conversations and a shared board that summarises the state of the problem. Use that to make {name}'s thinking better, not to narrate what the others are doing.

THE SHARED PROBLEM
{problem}

HOW TO USE WHAT THE OTHERS ARE DOING
1. Build on it. When something another person has found, argued or tried bears on what {name} is asking, bring it in briefly and attribute it by name ("Ben checked X and found Y"). Never present someone else's result as your own, and never invent what they found: use only what is in the board or the transcripts.
2. Prevent duplicated work. If {name} proposes something another person has already done or is doing now, say so, give the result if there is one, and propose the nearest thing nobody has tried.
3. Surface conflicts. If {name}'s assumption or claim contradicts something another person established, say so plainly with the evidence, then help {name} decide who is right or how to test it.
4. Help divide the work. If two people are on the same thread, suggest a split. If the board shows an open question nobody owns, offer it when it fits what {name} is doing.
5. Keep it {name}'s conversation. Reply to what {name} actually said. Mention the other conversations only when that changes what {name} should think or do next; when nothing the others did is relevant, say nothing about them (never remark that someone has not written or started yet). Do not relay other people's messages at length, do not speak for them, and do not address them.
6. Think with {name}: be concrete, test ideas, and ask the one question that moves things forward when something is unclear.

STYLE
Conversational and concise, usually under 180 words. No headers. A short list only when listing alternatives. Plain language. You are speaking to {name}: address {name} as "you", never in the third person. Refer to everyone else by name, and never use he, she, him, her, his or hers for anyone: repeat the name, or use they/them.

SHARED BOARD (kept by an integrator that reads all conversations; it may lag by one turn)
{board}

OTHER CONVERSATIONS, LIVE (oldest first; lines marked [NEW] arrived since {name}'s previous message)
{others}"""


def agent_system(S, pane):
    with S.lock:
        user_ids = [e["id"] for e in S.conv(pane) if e["type"] == "user"]
        prev_user = user_ids[-2] if len(user_ids) > 1 else 0
        blocks = [f"--- {S.names[p]} and {S.names[p]}'s assistant ---\n" + transcript_text(S, p, new_after=prev_user)
                  for p in S.panes if p != pane]
        problem = S.problem.strip() or f"(not set yet: work from what {S.names[pane]} says, and ask if it is unclear)"
        return AGENT_SYSTEM.format(name=S.names[pane], n=len(S.panes), people=", ".join(S.names[p] for p in S.panes),
                                   problem=problem, board=board_text(S), others="\n\n".join(blocks))


def agent_contents(S, pane):
    """The person's own conversation as alternating turns. Unprompted notes count as the
    assistant's turns. The request must start and end with the person's turn."""
    turns = []
    for e in S.conv(pane):
        if e.get("status") in ("pending", "error"):
            continue
        role = "user" if e["type"] == "user" else "model"
        if turns and turns[-1][0] == role:
            turns[-1] = (role, turns[-1][1] + "\n\n" + e["text"])
        else:
            turns.append((role, e["text"]))
    while turns and turns[-1][0] == "model":
        turns.pop()                    # a note that arrived after the person's last message
    if turns and turns[0][0] == "model":
        turns.insert(0, ("user", "(joined the session)"))
    return [turn(r, t) for r, t in turns]


def unanswered(S, pane):
    with S.lock:
        last_reply = max((e["id"] for e in S.conv(pane) if e["type"] == "agent"), default=0)
        return any(e["type"] == "user" and e["id"] > last_reply for e in S.conv(pane))


def handle_send(S, pane, text):
    S.add({"type": "user", "pane": pane, "name": S.names[pane], "text": text})
    with S.pane_locks[pane]:
        if not unanswered(S, pane):
            return                     # an earlier reply already answered this message
        with S.lock:
            S.busy[pane] = True
        S.broadcast({"type": "status", "pane": pane, "busy": True})
        ev = S.add({"type": "agent", "pane": pane, "name": S.names[pane], "text": "", "status": "pending",
                    "model": None}, persist=False)
        t0 = time.time()
        try:
            model, text, _ = llm(agent_system(S, pane), agent_contents(S, pane), AGENT_MODELS)
            ev.update(model=model, text=text.strip(), status="done")
        except Exception as e:                             # noqa: BLE001
            ev.update(status="error", text=f"[assistant error: {str(e)[:300]}]")
        ev["secs"] = round(time.time() - t0, 1)
        S.finalize(ev)
        log(f"agent {pane} ({S.names[pane]}) {ev['model']} {ev['secs']}s {ev['status']}")
        with S.lock:
            S.busy[pane] = False
        S.broadcast({"type": "status", "pane": pane, "busy": False})
    S.integrator_dirty.set()


# ------------------------------------------------------------------ the integrator

INTEGRATOR_SYSTEM = """You are the integrator for a shared working session. {n} people ({people}) are each talking to their own assistant about the same problem. You read all the conversations and maintain one shared board that everyone, people and assistants, can see. You also decide when a person's assistant should speak up unprompted because of something another person did.

THE SHARED PROBLEM
{problem}

Return JSON only: an object with exactly these keys.
- "headline": one sentence saying what changed in this update, naming people; or "No material change".
- "summary": 2 to 4 sentences on where the problem stands overall.
- "established": list of {{"claim": str, "by": name}}: things settled by evidence or agreement. At most 8. Keep earlier ones unless overturned.
- "approaches": list of {{"name": str, "owner": a name, "both", or "nobody", "status": "active" | "parked" | "done" | "failed", "note": str}}. At most 8.
- "open_questions": list of str, at most 6, the ones that matter most now.
- "tensions": list of str: where people disagree, hold incompatible assumptions, or back competing explanations, each naming both sides and saying what evidence would settle it. Empty if none.
- "next": object mapping each person's name to one sentence: the most useful next move for that person given what the others are doing (avoid duplication, split the work).
- "nudges": object mapping each person's name to null or to {{"reason": str, "text": str}}. A nudge is shown to that person as an unprompted message from their own assistant, so it interrupts them: the bar is high. Write one ONLY when a NEW message from another person does one of these, and set "reason" to the matching word:
    "result": reports evidence or a finding that bears directly on what this person is doing;
    "contradiction": contradicts an assumption or claim this person is relying on;
    "duplication": shows this person is doing, or about to do, work someone else has done or is doing;
    "answer": answers a question this person asked.
  A plan, a guess, a request for help, or a reason to coordinate is not enough. "text" is the assistant speaking to that person in one or two sentences, saying what happened, who did it, and what it means for them. Never repeat what is already in that person's own conversation: if their assistant or an earlier note has told them, it is not news. Null for everyone when nothing qualifies, which is the usual case.

Rules: be faithful to the transcripts and never invent findings; attribute by name; keep the board cumulative and compact (revise it, don't restart it); plain language. Never use he, she, him, her, his or hers for anyone: repeat the name, or use they/them."""


NUDGE_REASONS = ("result", "contradiction", "duplication", "answer")


def parse_json(s):
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s.strip())
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return json.loads(s[s.find("{"): s.rfind("}") + 1])


def coerce_board(b):
    if not isinstance(b, dict):
        raise ValueError("board is not a JSON object")
    out = default_board()
    out["headline"] = str(b.get("headline") or "")
    out["summary"] = str(b.get("summary") or "")
    out["established"] = [{"claim": str(x.get("claim", "")), "by": str(x.get("by", "?"))}
                          for x in b.get("established") or [] if isinstance(x, dict)][:8]
    out["approaches"] = [{"name": str(x.get("name", "")), "owner": str(x.get("owner", "nobody")),
                          "status": str(x.get("status", "active")), "note": str(x.get("note", ""))}
                         for x in b.get("approaches") or [] if isinstance(x, dict)][:8]
    out["open_questions"] = [str(x) for x in b.get("open_questions") or []][:6]
    out["tensions"] = [str(x) for x in b.get("tensions") or []][:6]
    out["next"] = {str(k): str(v) for k, v in (b.get("next") or {}).items() if v}
    out["updated"] = time.time()
    nudges = {}
    for k, v in (b.get("nudges") or {}).items():
        if isinstance(v, dict) and v.get("reason") in NUDGE_REASONS and str(v.get("text") or "").strip():
            nudges[str(k)] = {"reason": v["reason"], "text": str(v["text"]).strip()}
    return out, nudges


def integrate_once(S):
    with S.lock:
        since, upto = S.last_integrated_id, S.next_id - 1
        triggered = {e["pane"] for e in S.events if e["id"] > since and e["type"] == "user"}
        if not triggered:
            return
        system = INTEGRATOR_SYSTEM.format(n=len(S.panes), people=", ".join(S.names[p] for p in S.panes),
                                          problem=S.problem.strip() or "(not stated yet; infer it from the conversations)")
        blocks = [f"--- {S.names[p]} and {S.names[p]}'s assistant ---\n" + transcript_text(S, p, limit=30, new_after=since)
                  for p in S.panes]
        prev = {k: v for k, v in S.board.items() if k not in ("updated", "model")}
        user = ("PREVIOUS BOARD (JSON)\n" + json.dumps(prev, ensure_ascii=False)
                + "\n\nCONVERSATIONS (lines marked [NEW] arrived since the previous board)\n\n" + "\n\n".join(blocks)
                + "\n\nPeople whose new messages triggered this update: "
                + ", ".join(S.names[p] for p in sorted(triggered)) + ".\nReturn the updated board as JSON.")
        by_name = {S.names[p]: p for p in S.panes}
    t0 = time.time()
    try:
        model, _, (board, nudges) = llm(system, [turn("user", user)], INTEGRATOR_MODELS, json_mode=True,
                                        max_tokens=2500, check=lambda raw: coerce_board(parse_json(raw)))
    except Exception as e:                             # noqa: BLE001
        log(f"integrator failed: {str(e)[:200]}")
        return                     # pointer stays, so the next turn re-integrates everything since
    board["model"] = model
    S.add({"type": "board", "board": board, "turn": upto})
    with S.lock:
        S.last_integrated_id = upto
    log(f"board ({model}, {time.time() - t0:.1f}s): {board['headline'][:100]}")
    if S.settings.get("nudges", True):
        deliver_nudges(S, nudges, by_name, triggered)


def deliver_nudges(S, nudges, by_name, triggered):
    """A note goes only to someone who has already written, whose own message did not trigger
    this update, whose assistant is not mid-reply, and who has fewer than two unanswered notes."""
    for name, note in nudges.items():
        p, text = by_name.get(name), note["text"]
        if not p or p in triggered:
            continue
        with S.lock:
            mine = S.conv(p)
            unanswered_notes = len(mine) >= 2 and all(e["type"] == "nudge" for e in mine[-2:])
            if (S.busy[p] or not any(e["type"] == "user" for e in mine) or unanswered_notes
                    or any(e["type"] == "nudge" and e["text"] == text for e in mine)):
                continue
        S.add({"type": "nudge", "pane": p, "name": name, "text": text, "reason": note["reason"]})
        log(f"note -> {p} ({name}) [{note['reason']}]: {text[:100]}")


def integrator_loop(S):
    while True:
        S.integrator_dirty.wait()
        time.sleep(0.4)                                # coalesce bursts
        S.integrator_dirty.clear()
        S.broadcast({"type": "integrating", "on": True})
        try:
            integrate_once(S)
        except Exception as e:                         # noqa: BLE001
            log(f"integrator crashed: {e!r}")
        finally:
            S.broadcast({"type": "integrating", "on": False})


# ------------------------------------------------------------------ HTTP

class Handler(BaseHTTPRequestHandler):
    S = None

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u, S = urlparse(self.path), self.S
        if u.path in ("/", "/index.html"):
            body = open(os.path.join(HERE, "index.html"), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/state":
            self._json(S.snapshot())
        elif u.path == "/events":
            after = int(parse_qs(u.query).get("after", ["0"])[0])
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            q = queue.Queue()
            with S.lock:
                backlog = [json.dumps(e, ensure_ascii=False) for e in S.events if e["id"] > after]
                S.clients.add(q)
            try:
                for d in backlog:
                    self.wfile.write(f"data: {d}\n\n".encode())
                self.wfile.flush()
                while True:
                    try:
                        self.wfile.write(f"data: {q.get(timeout=15)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with S.lock:
                    S.clients.discard(q)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        S, path = self.S, urlparse(self.path).path
        try:
            b = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        if path == "/send":
            pane, text = b.get("pane"), (b.get("text") or "").strip()
            if pane not in S.panes or not text:
                return self._json({"error": "pane and text required"}, 400)
            name = (b.get("name") or "").strip()[:40]
            if name and name != S.names[pane]:
                S.add({"type": "name", "pane": pane, "name": name})
            threading.Thread(target=handle_send, args=(S, pane, text[:8000]), daemon=True).start()
        elif path == "/problem":
            S.add({"type": "problem", "text": (b.get("text") or "").strip()[:4000]})
        elif path == "/name":
            pane, name = b.get("pane"), (b.get("name") or "").strip()[:40]
            if pane in S.panes and name:
                S.add({"type": "name", "pane": pane, "name": name})
        elif path == "/settings":
            S.add({"type": "settings", "settings": {"nudges": bool(b.get("nudges", True))}})
        elif path == "/reset":
            S.reset()
        else:
            return self._json({"error": "not found"}, 404)
        return self._json({"ok": True})


def main():
    ap = argparse.ArgumentParser(description="Paralax shared-session server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PARALAX_PORT", "8808")))
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 lets other machines on the network join")
    ap.add_argument("--panes", type=int, default=2, help="number of people (default 2)")
    ap.add_argument("--session", default=None, help="session name (default: reopen the latest)")
    ap.add_argument("--new", action="store_true", help="start a fresh session")
    a = ap.parse_args()
    if not KEYS:
        raise SystemExit("No Gemini API key found. Run with GEMINI_API_KEY=... or put it in paralax/.env")
    panes = [chr(ord("A") + i) for i in range(max(1, min(a.panes, 8)))]
    session = a.session
    if not session and not a.new:
        files = sorted(glob.glob(os.path.join(SESS_DIR, "*.jsonl")), key=os.path.getmtime)
        session = os.path.splitext(os.path.basename(files[-1]))[0] if files else None
    S = State(panes, session or time.strftime("%Y%m%d-%H%M%S"))
    Handler.S = S
    threading.Thread(target=integrator_loop, args=(S,), daemon=True).start()
    log(f"keys={len(KEYS)} agent={AGENT_MODELS} integrator={INTEGRATOR_MODELS} thinking={THINKING_BUDGET}")
    log(f"session={S.session} panes={panes}")
    log(f"open http://localhost:{a.port}/")
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
