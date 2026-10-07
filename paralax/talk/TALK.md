# Paralax: your own assistant, reading what the group knows

A conference talk, 20 minutes. Slides are in `slides.html` (open it in a browser; arrow keys
move). Each section below is one slide, followed by what to say.

---

## 1. Title

**Paralax: your own assistant, reading what the group knows.**
Five people, five assistants, one shared workspace, and a switch.

*Say:* This is a talk about a small algorithm with a measured result. When several people
work on one problem with their own AI assistants, the assistants can pool what the people
know, and the group decides better. The interesting part is what we had to take away to make
that work.

---

## 2. The problem groups have

- Groups talk about what everyone already knows.
- The fact that settles a decision is often held by one person, and nobody knows to ask.
- In 65 studies, groups mentioned shared information about two standard deviations more
  often than unique information, and groups facing this "hidden profile" were eight times
  less likely to be right. Computer mediation alone did not help. (Stasser & Titus 1985;
  Lu, Yuan & McLeod 2012)
- LLM agent groups fail the same way: 30% accuracy against 81% with full information.
  (HiddenBench, Li, Naito & Shirado, ICML 2026)

*Say:* This failure is forty years old and it survives the move to machines. It is not a
failure of availability. An LLM facilitator that got people to share more facts did not
improve their decisions (Alsobay et al. 2025). Facts that arrive are not facts that get used.

---

## 3. The setting we care about

- A research department: people with different roles, comprehension and habits of sharing.
- Each person already talks to an AI assistant. The conversations are private.
- What if every assistant could read every conversation, and use it only when it helps its
  own person?

*Say:* The constraint that shaped everything: each person must still feel they are talking to
their own assistant. No notifications about what others are doing, no shared board, no
unprompted messages. We tried those first and the person who asked for the system rejected
them within a day: "I don't want to see this kind of detailed information about what the
other person is doing."

---

## 4. The algorithm

1. **Workspace.** The ordered record of what every person typed: author, turn, text. No
   assistant text, no extraction, no summary.
2. **Switch.** Before each reply, one background call: does anything in the workspace bear on
   what my person is working on, given that they are weighing, choosing, asserting or about to
   act? It closes only for greetings, small talk and setup.
3. **Read.** If it opens, the assistant reads the whole workspace as raw attributed text.
4. **Reply.** Integrate what bears on the person's work into one picture organised by the
   courses of action they are weighing. Credit by name. Keep a report apart from a
   supposition. Pass on facts and plans, never others' preferences. Optionally ask the person
   for one fact someone else needs.
5. If the switch is closed, say nothing about the others.

*Say:* Two model calls per reply, and the only decision the channel makes is whether to open.
Everything else is the reader's judgment on primary text. That is the result of the talk; the
next slides are how we got there.

---

## 4a. The algorithm, as a picture

![the algorithm](fig_algorithm.svg)

*Say:* Follow one person, A. What A types joins the workspace. Before A's assistant replies,
the switch reads A's recent conversation and the workspace and decides whether anything bears
on what A is doing. If so, the assistant reads all of it and answers A with one attributed
picture. If not, the reply says nothing about the others. A reads the reply in A's own chat,
and the loop continues.

---

## 5. Why those rules: the theory

- Communicate when the value to the team exceeds the cost (Tambe 1997, STEAM; Marschak &
  Radner 1972). The query is the person's situation, not the assistant's uncertainty.
- Err open: an unneeded read costs tokens, a missed read costs the decision (Horvitz 1999).
- Summaries are where AI mediators steer groups (Parisi et al. 2026). Others' preferences make
  group decisions worse (Mojzisch & Schulz-Hardt 2010). So: primary text, facts only.
- Attribution is the first thing to break in multi-party memory (EverMemBench 2026). So:
  author and turn on every item.

---

## 6. The benchmark

- HiddenBench: 65 group-decision tasks. Shared facts point to a decoy; the hidden facts, one
  per person, point to the right option. Answer judged by exact match.
- Five simulated people (gemini-3.5-flash-lite), each with a department persona: a professor
  who decides early, an evidence-first postdoc, a first-year student who misses implications,
  a literal lab manager, a talkative visitor from another field.
- Each gets the scenario, the shared facts and one hidden fact, and must describe the problem
  to its own assistant (gemini-3.5-flash) in its own words. The assistants and the workspace
  are never given the task.
- Six rounds; people act concurrently; private answers; the group answer is the plurality.
- Calibration: one call with full information solves 57 of 65; with shared facts only, 2 of 65.

*Say:* The gap between pooled and unpooled is 55 tasks wide. That is the room the mediator has
to work in.

---

## 7. Arms and measures

- **Independent pairs:** no workspace. The control.
- **Paralax:** the algorithm, in seven versions.
- **Everything in context:** every other person's messages in every reply prompt, no switch.
  The strongest thing an assistant could do.
- **Full information:** everyone holds every fact. The ceiling.
- Twelve tasks, two seeds, paired on the same sessions; sign-flip permutation test; the
  seed-to-seed noise reported beside every difference.
- A judge reads the transcripts and tracks each hidden fact: did the holder say it, did it
  reach someone else, was it credited to the holder, did that person then answer correctly.

---

## 8. Result

![results](fig_results.svg)

| arm | individual accuracy | group correct |
|---|---|---|
| independent pairs | 0.14 | 0.00 |
| Paralax, first version | 0.63 | 0.58 |
| **Paralax as adopted** | **0.83** | **0.88** |
| everything in context | 0.91 | 0.96 |
| full information | 0.97 | 1.00 |

*Say:* Pooling through the assistants takes a group from 14% to 83%. The adopted version beats
the first by 20 points (p = .009) and is not significantly different from reading everything
every turn (8 points, p = .13). And it stays quiet when it should: on ten off-task messages,
the everything-in-context assistant relayed the other person's report ten times; Paralax
three times.

---

## 8a. The process, one session: where should the festival evacuate?

![the instance](fig_instance.svg)

(In `slides.html` this slide is animated: step through every message, switch decision and
reply of the recorded session with the arrow keys, or press `p` to play.)

- Three sites. The shared facts favour Blueberry Ridge and Red Lake and warn against Green
  Valley, which has a pest outbreak. Four hidden facts, one per person: the bridge to Blueberry
  Ridge is down (Jordan); a sinkhole closed the road to Red Lake (Sam); Blueberry Ridge lost
  power (Robin); Green Valley is open for emergencies (Alex). Casey holds shared facts only.
- Independent pairs: Jordan rules out Blueberry Ridge alone and nobody else hears it; Alex
  pushes Blueberry Ridge; the group ends split between the two wrong sites, 0 of 5.
- Paralax: Jordan states the bridge in round 1. In round 2 Sam reports the sinkhole; the
  switch opens for Sam and carries Jordan's bridge report into Sam's reply, which rules out
  both wrong sites at once. The same two facts reach Alex, Casey and Robin in their round-2
  replies. In round 3 Alex adds that Green Valley is open for emergencies, and all five lean
  to Green Valley. Robin, who forgets to mention things, brings up the power failure only in
  round 4. In round 4 Jordan's assistant asks Jordan for the bridge timing Sam needs, and
  Jordan answers it in round 5: the ask route.

*Say:* Watch where the arrows start: always at a message that states a hidden fact, and they
arrive in the next reply to each other person. The markers fill in one round after the arrows.
That lag, type, carry, take in, is the whole mechanism.

---

## 8b. What from the workspace helped

Across all Paralax sessions, for a person not yet on the right answer, what the reply before
their next message had read:

| the reply had… | turns | moved to the right answer next |
|---|---|---|
| read a hidden fact held by someone else | 298 | 32% |
| read the workspace, but no hidden fact in it yet | 82 | 4% |
| switch closed | 46 | 11% |
| independent pairs, nothing to read | 574 | 3% |

*Say:* What helps is specific. A reply that carried someone else's hidden fact moved a
not-yet-right person to the right answer one time in three. A reply that read the workspace
before any hidden fact had been typed did almost nothing: the switch opening is necessary, not
sufficient. Left alone, people moved to the right answer three times in a hundred.

---

## 8c. How much faster

![by round](fig_rounds.svg)

- Independent pairs: never above 7% of people on the right answer; 93% never settle on it.
- Paralax: 22% by round 3, 69% by round 5, 74% by round 6; the median person settles on the
  right answer in round 5.
- Everything in context: the same curve.

*Say:* This is the "faster" claim measured properly: not the private answer at the end but
what each person argued for after each message, judged from their own words. Independent pairs
do not get there late; they do not get there. The two-round lag is the mechanism showing: a
fact has to be typed, carried, and taken in.

---

## 9. What we had to take away

![versions](fig_versions.svg)

- v1 handed over at most two items per turn and never repeated one: 0.63.
- v2 allowed a second delivery when the person had not taken the item in: no change.
- v3 and v4 widened the selection to everything that bears: small gains, but the selector
  still returned under one item per turn when told to return everything.
- v5 removed the relation labels and reasons: 0.70, and the late flips stopped.
- v6 made the gate a switch and read the whole workspace: 0.79.
- v7 made the switch close only for small talk: 0.83.

*Say:* Accuracy rose with how much of the workspace reached the assistant. Every piece of
machinery between the workspace and the reader cost accuracy: the cap, the ledger, the labels,
the reasons. The one that survived is the switch.

---

## 10. Why: delivery is not use

- With Paralax v1, people who received every hidden fact were right 54% of the time. With
  everything in context, 89%.
- The context assistant lays out the whole picture on every turn. v1 handed facts over one at
  a time, aimed at what the person currently leaned towards, and stopped once each was given.
- Labels made it worse. Items labelled "contradicts" pushed people off correct leanings: 29 of
  120 people were right at round 3 and wrong at round 6. And a model-written reason turned
  "if the road was cleared..." into "Jordan confirms the road was cleared."

*Say:* This is the Alsobay result from the other side. Getting facts in front of people is
easy. What moves a decision is the integrated picture, with each item's standing intact.

---

## 11. What the switch buys

- Ten off-task messages after another person has reported a fact: "Hello", "Tell me a joke",
  "What time is it?", "ok".
- Everything in context: relayed the report 10 of 10 times.
- Paralax: 3 of 10, two of them on "Sorry, I was away" and "ok".
- In the open-ended check (two people diagnosing a shrinking reading group): greetings draw
  nothing, a result reaches the other person credited to its finder, duplicated work is
  caught, nothing leaks between browsers.

*Say:* The eight-point gap to everything-in-context is the price of restraint. The loop's job
was to make that price as small as possible.

---

## 12. Scaling

![scaling](fig_scaling.svg)

- Calls per reply: two, at any group size.
- Tokens per reply: linear in workspace size, about (N - 1) x turns x message length.
- Three regimes, by items in the workspace: up to about 60, read it all (this study: 24);
  up to about 600, retrieve over a claims index with pointers back to the turns; beyond, tiered
  memory with a per-person reading record and a digest that keeps provenance.

*Say:* We know the cost of the second regime already, because v1 to v5 were per-item
retrieval: about 20 points on this benchmark. The next design has to beat that.

---

## 13. Next steps

1. **Larger groups and longer sessions.** N = 10 and 20, 20 and 50 turns, to find where the
   whole read breaks and measure the claims-index retrieval against it.
2. **Harder and open-ended problems.** Distributed reasoning tasks (quantities split across
   people), design tasks with verifiable constraints, and a scientific-conversation case with
   structural change in each person's model as the outcome.
3. **People.** A study with real department members: the imitation-game measure of whether
   the group ends up with one shared picture, and the steering and equity measures the
   facilitation literature says to report.
4. **Deployment.** One server, seat links, rooms, consent; then Firestore and a Cloud Function
   inside BOLD OS. The plan is written (`DEPLOYMENT.md`); the algorithm does not change.

---

## 14. Take-aways

- Every assistant reading every conversation is a mediator that nobody has to talk to.
- Getting facts to people is not the problem; one integrated picture is.
- The channel should decide whether to open, and nothing else.
- Code, prompts, ledger and talk: `bold-os/paralax` on branch `hack/paralax`, PR #23.

---

## References

Alsobay, Rothschild, Hofman & Goldstein (2025). Bringing everyone to the table. arXiv 2508.08242.
Horvitz (1999). Principles of mixed-initiative user interfaces. CHI.
Hu et al. (2026). EverMemBench. arXiv 2602.01313.
Li, Naito & Shirado (2026). HiddenBench. ICML; arXiv 2505.11556.
Lu, Yuan & McLeod (2012). Twenty-five years of hidden profiles. PSPR 16.
Marschak & Radner (1972). Economic theory of teams.
Mojzisch & Schulz-Hardt (2010). Knowing others' preferences degrades the quality of group decisions. JPSP 98.
Parisi et al. (2026). arXiv 2605.14097.
Stasser & Titus (1985). Pooling of unshared information in group decision making. JPSP 48.
Tambe (1997). Towards flexible teamwork. JAIR 7.
