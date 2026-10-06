# Paralax

Several people work on one problem at the same time. Each person talks to their own AI
assistant, and every assistant reads every conversation, live. Each person still has a
private-feeling, one-to-one conversation, but their assistant knows what the others have
tried, found and are doing right now. The assistant uses that to keep its person from
repeating work, to bring in results as they land, and to flag contradictions.

It is a standalone prototype: one Python file and one HTML page. It needs no npm, Firebase or
emulators, and it does not touch the rest of BOLD OS.

## Run it

You need Python 3.9 or newer (macOS ships it) and a Gemini API key. Nothing to install.

```sh
GEMINI_API_KEY=your-key python3 paralax/server.py
```

Open http://localhost:8808/. You get two chat boxes with the shared board between them.
Each person types their name at the top of a box and uses that box.

To use two laptops, start the server with `--host 0.0.0.0` on one machine. On each laptop,
open `http://<that-machine>:8808/?pane=A` or `?pane=B` to get a single box plus the board.

Other options:

| Flag or variable | Effect |
|---|---|
| `--panes 3` | three people (up to 8) |
| `--new` | start a fresh session; by default the latest one reopens |
| `--session NAME` | open a named session |
| `paralax/.env` | put `GEMINI_API_KEY=...` here instead (gitignored); several keys may be comma-separated |
| `PARALAX_MODELS` | assistant model chain, default `gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite` |
| `PARALAX_INTEGRATOR_MODELS` | board model chain |
| `PARALAX_HEDGE_SECS` | seconds before the next model is also tried, default 6 |

Each session is saved as `paralax/sessions/<name>.jsonl`, one event per line. This folder is
gitignored.

## How it works

There are three parts, arranged as a blackboard system.

1. **One assistant per person.** The assistant's message history is only its own person's
   conversation, so it answers as that person's assistant. Its instructions also contain the
   shared problem, the current board, and every other conversation verbatim, with lines that
   arrived since its person last spoke marked NEW. Six rules govern how it uses the other
   conversations:
   - build on them, with attribution by name;
   - head off duplicated work;
   - surface contradictions;
   - help divide the work;
   - mention the others only when that changes what its person should do;
   - think concretely with its person.
2. **The integrator.** After every reply it rewrites one shared board from the previous board
   and all the conversations. The board holds a summary, established claims with who
   established them, approaches with owner and status, open questions, tensions, and one
   suggested next move per person. Everyone sees the board, and every assistant reads it.
3. **Unprompted notes.** The integrator may also give a person a one- or two-sentence note
   from their own assistant, without that person asking. A note is allowed only when a new
   message from someone else does one of these things:
   - reports a result that bears on this person's work;
   - contradicts an assumption this person relies on;
   - shows this person is duplicating work;
   - answers a question this person asked.

   Each note must state which of these four reasons applies, and notes without one are
   dropped. A person never gets more than two unanswered notes, and never one about their
   own turn. The "unprompted notes" checkbox turns notes off.

Why this design:

- **Every assistant reads everything instead of relaying messages.** Relaying needs a decision
  about what to pass on, and that decision is where the useful information gets lost. Reading
  everything lets each assistant judge relevance against its own person's question at the
  moment that person asks it.
- **The board exists alongside the transcripts.** Transcripts grow without limit and mix
  results with chatter. The board is the compressed shared state: what is established, who
  owns which approach, and where people disagree. It is also the one thing the people see
  that is not their own conversation.
- **Notes need a stated reason.** Without that, the integrator interrupted after nearly every
  turn, mostly to suggest coordinating.

## What a test session showed

Priya and Tom were asked why a reading group fell from 14 attendees to 4.

- Priya suspected long papers and planned a survey. Tom suspected the move from Tuesday to
  Friday.
- When Tom reported that 8 of the 10 people who left stopped in the first week after the
  move, Priya got an unprompted note with that result.
- When Priya next asked whether to send the survey, Priya's assistant advised holding off.
  It cited Tom's numbers and suggested asking about the meeting time instead.
- When Tom then proposed a separate scheduling poll, Tom's assistant pointed out that Priya was
  already preparing one.

## Shipping it inside BOLD OS

The prototype uses names typed into boxes and an in-memory server. A real BOLD OS feature
would need these pieces.

- **Identity.** Slack sign-in replaces the name boxes. A session is a room with a member list.
- **Live sync.** Firestore documents replace the server's event stream: `paralaxRooms/{id}`
  holds the problem and board, `paralaxRooms/{id}/messages` holds the messages, and
  `onSnapshot` gives each page live updates.
- **Model calls.** A Cloud Function, triggered on each new message, holds the Gemini key as a
  secret. It runs the assistant and integrator prompts from `server.py` unchanged.
- **Rules.** Only room members can read or write a room.
- **Consent.** The room makes clear that every member's assistant reads every conversation in
  the room. That visibility is the feature, so people need to know it before they type.

## Files

- `server.py` holds the state, both prompts (`AGENT_SYSTEM` and `INTEGRATOR_SYSTEM`), the
  model chain, and the HTTP and event-stream endpoints.
- `index.html` is the page. It uses the BOLD OS design tokens from
  `src/assets/css/bold.css`. The `?pane=X` parameter shows a single box.
- `.env.example` is the key template.
