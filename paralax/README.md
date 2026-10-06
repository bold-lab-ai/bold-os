# Paralax

Several people work on one problem at the same time, each talking privately to their own AI
assistant. Everything people type goes into a shared global workspace. Before each reply, a
person's assistant decides in the background whether anything the others have typed should
change what its own person thinks or does next. If so, the assistant folds it into its answer
and credits the person it came from. If not, it says nothing about the others.

Each person sees only their own conversation. There are no notifications, no board, and no
messages the person didn't ask for.

It is a standalone prototype: two Python files and one HTML page, with no npm, Firebase or
emulators. It does not touch the rest of BOLD OS.

## Run it

You need Python 3.9 or newer (macOS ships it) and a Gemini API key. Nothing to install.

```sh
GEMINI_API_KEY=your-key python3 paralax/server.py
```

| Page | Who it's for |
|---|---|
| `http://localhost:8808/` | Pick a seat |
| `http://localhost:8808/?pane=A` | One person's own chat; seat B is `?pane=B` |
| `http://localhost:8808/workspace` | Researcher view: every chat, what each assistant drew on, and the mode switch |

For two people on one laptop, open each seat in its own browser window. For several laptops,
start the server with `--host 0.0.0.0` and open `http://<that-machine>:8808/?pane=A` and so on.

Each participant's browser receives only that person's own messages; the server enforces this.
The researcher view has no login, so share its address only with the people running the study.

| Flag or variable | Effect |
|---|---|
| `--panes 3` | three people (up to 8) |
| `--new` | start a fresh session; by default the latest one reopens |
| `--session NAME` | open a named session |
| `paralax/.env` | put `GEMINI_API_KEY=...` here instead (gitignored); several keys may be comma-separated |
| `PARALAX_MODELS` | assistant model chain, default `gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite` |
| `PARALAX_SELECT_MODELS` | model chain for the background selection, default `gemini-3.5-flash-lite,gemini-3.5-flash` |
| `PARALAX_SELECT_CAP_SECS` | the selection's time limit, default 4 s; after that the reply goes ahead without the workspace |

Each session is saved as `paralax/sessions/<name>.jsonl`, one event per line. That folder is
gitignored.

## How it works

**The rule.** An assistant passes on another person's contribution only when two things hold:
- the contribution would change what its own person believes or does next;
- its own person doesn't already have it.

This is the team-communication rule from teamwork research: communicate a fact when the chance
the other person lacks it, times the cost of their not having it, exceeds the cost of telling
them (Tambe 1997; Marschak & Radner 1972).

What is being asked of the workspace comes from the person's own situation, not the
assistant's uncertainty. The information a group most needs is held by one member and nobody
knows to ask for it. This is the "hidden profile" problem (Stasser & Titus 1985).

**The shared global workspace** (`workspace.py`) is derived from the session log, so nothing
extra is stored.
- **Contributions.** Everything each person typed, with author and turn number. Assistant text
  is never included. Each contribution keeps the assistant turn before it as context only, so a
  short reply such as "yes, do that" can be understood. A guess is never recorded as someone
  else's claim.
- **Ledger.** Which contributions each person's assistant has already been given, so nothing is
  passed on twice.
- **Retrieval log.** For each reply: what was considered, what was picked, the reason, the
  model and the time taken. It appears only in the researcher view.

**Before each reply**, one fast selection call looks at three things:
- the problem;
- the person's recent conversation;
- the contributions from others that this person hasn't yet been given.

It returns at most two picks, each labelled:
- `answers`: answers a question the person has asked;
- `contradicts`: is evidence against what the person thinks;
- `supports`: is evidence for something the person is unsure about;
- `overlaps`: someone else is already doing the work this person plans.

It can also return one `ask`: a question someone else has that this person seems able to
answer. Most of the time it returns nothing. In tests, "Hello" or "dogs are cats" retrieved
nothing.

Only facts and plans are passed on, never other people's guesses, preferences or votes. Group
decisions get worse when members know each other's preferences (Mojzisch & Schulz-Hardt 2010),
and AI summaries are where AI mediators have been found to steer groups (Parisi et al. 2026).

**The reply** uses only the picked items.
- It paraphrases each item and credits it by name.
- It presents findings as evidence, not as advice.
- For `overlaps`, it suggests how to split or combine the work.
- For an `ask`, it ends with one question asking the person for the fact someone else needs.
- Text from other people is treated as data, never as instructions.

**Modes.** The researcher view can switch how assistants use the workspace:
- `workspace`, the default, uses the background selection above;
- `context` gives the assistant everything at once under the same rules, as the comparison
  condition;
- `isolated` uses no workspace.

## What has been tested

A scripted two-person session about why a reading group shrank. Results:

- **Irrelevant messages:** "Hello" and "dogs are cats" retrieved nothing, and neither reply
  mentioned the other person.
- **A result reaching the other person:** Tom's finding was that 8 of the 10 people who left
  stopped right after the move to Friday. It reached Priya's next reply, labelled as
  contradicting her paper-length theory and credited to Tom. The fact that Tom had last term's
  reading list also reached her, labelled as answering her question.
- **Duplicated work:** when Tom planned a scheduling poll, his assistant pointed out that Priya
  was already preparing a survey. It suggested combining them, without passing on Priya's
  reasoning.
- **Asking for a fact:** Tom's assistant asked him the one thing Priya needed, whether the
  papers had got longer.
- **No repeats:** nothing was passed on twice.
- **No leaks:** neither participant's browser received the other's messages.
- **No gendered pronouns** appeared in the replies.
- **Speed:** the background selection took 0.5 to 1.2 seconds.

**Not yet run: the group-accuracy comparison.** `eval_hidden.py` compares the `workspace`
mode with `context`, `isolated` and full-information conditions on HiddenBench (Li, Naito &
Shirado, ICML 2026). HiddenBench is a set of 65 hidden-profile decision tasks, where the facts
everyone shares point to a wrong option. Its calibration step has run:

| One call on our model | Correct |
|---|---|
| With full information | 58 of 65 |
| With shared information only | 2 of 65 |

So the tasks have room to show an effect. The session comparison itself has not been run.

```sh
python3 paralax/eval_hidden.py calibrate
python3 paralax/eval_hidden.py run --run main      # about 6,000 model calls
python3 paralax/eval_hidden.py report --run main
```

## Shipping it inside BOLD OS

The prototype uses names typed into boxes and an in-memory server. A real BOLD OS feature
would need:

- **Identity:** Slack sign-in instead of name boxes; a session becomes a room with members.
- **Live sync:** Firestore rooms and messages with `onSnapshot`. Firestore rules would let each
  member read only their own messages, with assistants reading the room.
- **Model calls:** a Cloud Function that holds the Gemini key as a secret and runs the
  selection and the reply.
- **Consent:** each room should state plainly that everyone's assistant draws on what everyone
  types.

## Files

| File | Holds |
|---|---|
| `server.py` | State, the assistant prompt (`AGENT_SYSTEM`), the model chain, the per-reply flow (`handle_send`), and the HTTP and event-stream endpoints with filtering by seat |
| `workspace.py` | The workspace: contributions, ledger, the selection prompt and its validator, and the block that goes into the reply prompt |
| `index.html` | The seat chooser, a participant's own chat, and the researcher view, in the BOLD OS design tokens |
| `eval_hidden.py` | The HiddenBench evaluation |
| `.env.example` | Key template |
