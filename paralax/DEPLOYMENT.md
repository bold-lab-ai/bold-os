# Running Paralax on one server for users on different computers

The prototype already runs as one server with many browsers. What it lacks for real use is
identity, rooms, encryption in transit, and a way to hand out seats. This plan goes from the
current state to a shared server in three steps, each usable on its own.

## Step 0: what works today

```sh
PARALAX_ENV=... python3 paralax/server.py --host 0.0.0.0 --panes 5
```

Everyone on the same network opens `http://<server>:8808/?pane=A` (B, C, ...). Each browser
receives only its own seat's messages; the researcher opens `/workspace`. Good enough for a
lab room or a workshop on one Wi-Fi network. Two gaps: anyone who guesses a seat letter can
sit in it, and the traffic is unencrypted.

## Step 1: one server on the internet, several groups at once (about a day)

Changes to `server.py`, all small:

- **Rooms.** `State` already holds one session. Keep a dictionary of `State` objects keyed by
  room id, created on demand, each with its own JSONL under `sessions/<room>/`. Every route
  takes the room from the path: `/r/<room>/`, `/r/<room>/state`, `/r/<room>/events`,
  `/r/<room>/send`.
- **Seat tokens.** When a room is created, the server mints one random token per seat and one
  researcher token. A seat link is `/r/<room>/?seat=<token>`; the server maps the token to the
  pane and never trusts a pane letter from the client. `visible()` and the SSE registration
  already filter by pane, so the only change is where the pane comes from.
- **Room creation page.** A form asking for the number of seats and an optional problem
  statement, returning the seat links to copy into Slack or email. The researcher token goes to
  whoever created the room.
- **Idle rooms.** Drop a room's in-memory state after an hour of silence; the JSONL stays and
  reloads on the next request.
- **Limits.** One reply in flight per seat already (the pane lock); add a per-room cap on
  messages per minute, and a cap on rooms per hour from one address.

Operations, no code:

- **HTTPS and a hostname.** Put Caddy in front: two lines of config give automatic
  certificates and a reverse proxy to port 8808. Server-sent events pass through unchanged.
- **Process.** A `systemd` unit (or `launchd` on a Mac) that restarts the server and keeps
  the Gemini key in an environment file readable only by the service user.
- **Backups.** The `sessions/` tree is the only state; copy it nightly.

What this gives: a link per person, groups anywhere, no accounts, no database. What it does
not give: knowing who a person is beyond the name they type.

## Step 2: identity and consent (about a day)

- **Sign-in.** For BOLD, Slack sign-in as the rest of BOLD OS does it: the room creator picks
  members, each member gets a seat on signing in, names come from Slack. Outside BOLD, email
  magic links do the same job.
- **Consent screen.** Before the first message, each person sees one sentence stating that
  every assistant in the room reads what everyone types, and clicks to continue. The
  acceptance is logged in the room's JSONL.
- **Researcher access.** Only the room creator and named researchers can open `/workspace`
  and `/viewer` for that room.
- **Retention.** A room's log is deleted after a stated period unless its creator keeps it.

## Step 3: inside BOLD OS (a few days)

Replace the Python server with the pieces BOLD OS already runs:

- **Firestore** holds rooms (`paralaxRooms/{room}`: members, problem, settings) and messages
  (`paralaxRooms/{room}/messages/{id}`: pane, type, text, time, and for retrieval records the
  ids read). `onSnapshot` replaces server-sent events.
- **Security rules** let a member read only messages of their own seat plus room-level fields;
  the Cloud Function reads the whole room.
- **A Cloud Function** triggered on each new person message runs `workspace.py`'s switch and
  the reply, holding the Gemini key as a secret. The prompts move across unchanged.
- **The pages** become Eleventy pages under `src/pages/paralax/`, styled by `bold.css`.

The algorithm does not change across the three steps. Only where the state lives and who is
allowed to read it.

## Scaling the algorithm itself

The server cost is two model calls per reply at any group size. What grows is the size of the
workspace each call reads: roughly (N - 1) x turns x message length. The talk's scaling figure
marks the regimes:

1. up to about 60 items (this study: 5 people, 6 turns, 24 items): read the whole workspace;
2. up to about 600 items: keep a claims index (each claim with its holder and a pointer to the
   turn) and let the switch retrieve the items that bear on the person's current work; the
   assistant still reads primary text, never a summary;
3. beyond that: tiered memory, with the index, a per-person reading record, and a digest that
   keeps provenance, used only for what the index cannot reach.

The second regime is the next thing to build and measure, with the per-item cost this loop has
already quantified as the baseline to beat.
