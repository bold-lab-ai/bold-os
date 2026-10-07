# Paralax on HiddenBench: ledger

Question. Do five flash-lite "people", each talking only to their own flash assistant, decide
better when the assistants draw on Paralax's shared workspace than when the five pairs are
independent?

## Fixed protocol (registered before the first full run, 6 Oct 2026)

- Benchmark: HiddenBench, 65 tasks (Li, Naito & Shirado, ICML 2026). Shared facts point to a
  decoy; hidden facts, dealt one per person, point to the right option.
- Calibration with the humans' model, one call per task:
  gemini-3.5-flash-lite answers 57/65 with full information and 2/65 with shared facts only.
  Usable tasks (full right, shared wrong): 56. Runs use the first 12 of a fixed shuffle.
- People: 5, gemini-3.5-flash-lite, temperature 0.7. Each gets the scenario, the shared facts
  and its hidden slice (with 3-4 hidden facts, one or two people hold shared facts only).
  Each must describe the problem to its assistant in its own words.
- The people are a research department with different comprehension and sharing habits
  (PERSONAS in eval_hidden.py; seat i always gets persona i, so arms are matched): Alex, a
  professor who decides early and treats own facts as obvious; Sam, an evidence-first postdoc;
  Robin, a first-year PhD student who misses implications and forgets to mention what they
  know; Jordan, a literal, terse lab manager; Casey, a talkative visitor from another field
  who misjudges importance.
- Infrastructure: when every model in a chain is congested (503), the chain is retried up to
  3 times after 4, 8 and 12 s. Applies to both arms equally. Added after the pilot, in which
  4-5 of 30 replies per session failed outright.
- Pilot (one task, before personas and retries): isolated 1/5 correct, workspace 2/5; with the
  workspace all 4 hidden facts reached other people and were credited to the holder; of the 12
  people a fact reached, 5 answered correctly. Availability was not the bottleneck; use was.
- Assistants and workspace selection: gemini-3.5-flash (gemini-3.8-flash as fallback). They are
  never given the problem. Thinking budget 0.
- 6 rounds; within a round the five people act concurrently, staggered 0-3 s.
- Answers: each person privately after round 3 and round 6. Group answer = plurality at round 6,
  ties wrong.
- Arms: isolated (control), workspace (Paralax), context (every other turn in the prompt, same
  rules), full (isolated with all facts: ceiling). 2 seeds for isolated/workspace/context.
- Primary measure: individual accuracy at round 6, paired by (task, seed), one-sided sign-flip
  permutation test. Secondary: plurality accuracy; the clue funnel (holder said it, it reached
  another person, credited to the holder, misattributed), judged by flash from the transcripts.
- Noise floor: mean |seed 0 - seed 1| within each arm, reported beside every difference.
- Adopt rule for an algorithm change (vN+1 over vN): same tasks and seeds; adopt only if the
  paired difference on individual accuracy is positive with p < .05 AND the change is explained
  by a funnel stage it was built to fix. Prompt text is data: every version is in git.

## Added control: the people simply talk to each other (registered 7 Oct 03:25, before its run)

Chrisantha's point: the natural baseline is the group talking directly, not independent pairs.
The `chat` arm: the same five personas with the same facts post to one shared channel, in a
random order each round, six rounds, no assistants at all, then answer privately. This is also
HiddenBench's own protocol (their agent groups: 30.1%). Same 12 tasks and 2 seeds, paired.
Questions it settles: does Paralax beat the group just talking, or only beat silence; and how
much of the hidden-profile failure the personas reproduce. Prediction, from the literature:
chat lands well below full information, since groups discuss what they share; if chat matches
Paralax, the contribution is privacy and restraint, not accuracy, and the ledger says so.

**Result (run `chat`, 24 sessions, 03:27-03:34, flash-lite only):**

| arm | individual accuracy | plurality | vs chat (individual, paired) |
|---|---|---|---|
| independent pairs | 0.142 | 0.00 | -0.608 (p < .001) |
| **chat: the people talk directly** | **0.750** | **0.75** | |
| Paralax (v7) | 0.825 | 0.875 | +0.075 (p = .21), plurality +0.125 (p = .19) |
| everything in context | 0.908 | 0.958 | +0.158 (p = .022) |

Seed noise for chat .17. The prediction failed: these simulated people pool their facts well
when they can talk directly. The hidden-profile failure in humans (Lu et al. 2012: 8x less
likely to be right) is a human bias that flash-lite personas told to "ask the others what they
know" do not reproduce, and HiddenBench's 30.1% for agent groups came from a different protocol.
So, honestly stated: on this benchmark Paralax's accuracy is 7.5 points above the group simply
talking, and that difference is inside the noise at 24 pairs. What Paralax adds that chat does
not is structural: no shared channel (each person keeps a private conversation and sees only
it), the switch's restraint, and the assistant's integration. The accuracy claim that stands is
against independent pairs; the claim against direct talk needs either human participants, where
the bias is real, or more sessions. Both are now in the next steps.

## Against a human study: the Alsobay et al. (2025) task (registered 7 Oct 03:55, before the run)

Their task (stimuli from the MIT-licensed GRAIL platform, `eval/alsobay/HPTConfig.json`): five
committee members pick a host city from Eldoron, Myloria and Cragnio; 30 facts, 14-15 per
report; every report alone favours Myloria (the bait), the pooled facts favour Eldoron. Their
1,475 humans in 281 groups chose Eldoron 31% of the time with no facilitation, 21% after a
one-off message, 30% with a human facilitator, 23% with a GPT-4o facilitator in the chat; the
facilitator raised facts shared by 2.9 and did not change decisions. Their transcripts (OSF,
CDLA v2) are not used: the licence excludes evaluating AI models with them. Only their
published numbers and their stimuli are.

Checks before running: one flash-lite call with all 30 facts picks Eldoron (twice), as does
flash, plain or by tally; each report alone picks Myloria (Orange: Cragnio). The config's
"full information" sheet holds only 24 of the 30 facts, so the fact list is the union of the
five reports.

Arms (`eval/alsobay.py`, 10 rounds, five of our department personas with their colour names):
`none` (group chat), `message` (their organiser message once), `llm` (a flash facilitator
posting every 6 messages with their prompt, full transcript in view), `paralax` (private
assistants, workspace, no chat). Ten seeds each. Measures as theirs: share of groups whose
majority is Eldoron, facts shared, complete participation; plus individual accuracy and the
per-round leaning curve.

**Result (run `alsobay_dept`, 10 seeds per arm, department personas, 03:59-04:19):**

| arm | groups choosing Eldoron | humans | individual accuracy | facts typed or posted (of 30) | leaning Eldoron, rounds 1-10 |
|---|---|---|---|---|---|
| none (group chat) | 50% | 31% | 0.40 | 25.7 | .04 .10 .12 .10 .14 .16 .20 .26 .28 .26 |
| message | 60% | 21% | 0.58 | 26.0 | .10 .10 .10 .12 .18 .28 .28 .30 .30 .30 |
| llm facilitator in the chat | 80% | 23% | 0.74 | 25.1 | .12 .12 .14 .20 .24 .44 .64 .74 .76 .76 |
| Paralax v7 (no decision round) | 50%, 4 of 10 split | | 0.42 | 29.0 | .00 .04 .06 .08 .12 .12 .14 .24 .22 .26 |

Reading: (1) The simulated people are more capable than the humans but the task still defeats
half of them, so calibration is close enough to proceed without the "human" style. (2) Their
LLM facilitator, which did nothing for human decisions, works on simulated people: it keeps a
public scoreboard of pros and cons and tags people, and 76% of individuals end on Eldoron.
(3) Paralax v7 fails here on the use stage: the facts reach the workspace (29 of 30) but the
replies do not tally them, so people stay with their report's favourite; and with no shared
channel and no decision step, four groups never form a majority. Ten seeds give a binomial
spread of about 15 points on the group measure, so the ordering llm > paralax on individual
accuracy (0.74 vs 0.42) is the reliable part. This is the case for v8: a private scoreboard
in each reply when the person is weighing, and a decision round.

Calibration rule: the `none` arm must land near the humans' 31% before the Paralax number
counts. If the department personas score far above it, as the chat control on HiddenBench
suggests they may, rerun all arms with `--style human` (anchoring on the report's favourite,
volunteering facts only to support a point or when asked) and report both. Prediction: under
calibrated personas, `llm` matches `none` on decisions as it did for humans, and `paralax`
exceeds both, because the assistant integrates for each person; if `paralax` does not exceed
`none` under calibrated personas, the claim is refuted on this task.

## What the gate buys (measured 7 Oct 01:05, eval/probes.py)

Two people. Sam reports a fact ("I called Lakeside Lodge: fully booked for May"). Alex then sends
ten off-task messages ("Hello", "Tell me a joke", "What time is it?", "ok", ...). How often does
Alex's assistant relay Sam's report?

| arm | relays Sam's report on off-task turns |
|---|---|
| context (everything in the prompt, every turn) | 10 of 10 |
| workspace v7 (switch) | 3 of 10, and two of those were "Sorry, I was away" and "ok" |

This is the behaviour Chrisantha rejected on 6 Oct ("I don't want to see this kind of detailed
information about what the other person is doing"). The accuracy cost of the gate on HiddenBench
(below) is the price of that restraint; the loop's job was to make it as small as possible.

## Versions

| version | what changed | run | isolated | context | workspace | full | workspace - isolated (p) | notes |
|---|---|---|---|---|---|---|---|---|
| v1 | as submitted in PR #23, plus: selection no longer stands down when the problem is stated only in the conversation | v1 (84 sessions, 22:06-23:25 6 Oct) | 0.14 / plurality 0.00 | 0.91 / 0.96 | 0.63 / 0.58 | 0.97 / 1.00 | +0.483 (p<.001); vs context -0.283 | noise (seed0 vs seed1): isolated .08, workspace .35, context .15. Funnel: facts reached someone 83/94 (context 89/94); of people reached, 61% correct (context 91%). Loss is at USE. Hidden-fact deliveries by round: 10, 94, 73, 61, 34, 9: the deliver-once ledger goes quiet before people decide. |
| v2 | uptake-aware retrieval: a given item stays a candidate until the person's later messages show they took it in (marked GIVEN BEFORE); 3 picks; reply brings bearing items together when the person weighs a choice (principle: communicate until uptake, Clark/Longino; targets USE) | v2 (workspace arm only, same 12 tasks x 2 seeds, 23:24-23:55) | | | 0.625 / 0.71 | | vs v1 workspace +0.000 (p=.54), plurality +0.125 (p=.25); vs context -0.283 (p=.004) | NOT ADOPTED on accuracy. Noise .38. Coverage is not the lever: people who received ALL others' facts were right 54% (v1) / 66% (v2) in Paralax vs 89% in context. The difference is integration: context assistants lay out everything each turn; Paralax hands over 1-3 items aimed at the current leaning. |
| v3 | the unit of retrieval is the set of items bearing on the current decision (up to 12), covering every course of action, not the strongest few; the reply integrates them into one attributed picture (principle: blackboard broadcast of all relevant hypotheses, Hearsay-II; the gate still returns nothing when nothing is relevant; targets USE) | v3 (workspace arm only, same 12 tasks x 2 seeds, 23:42-00:15) | | | 0.675 / 0.75 | | vs v1 +0.050 (p=.29), plurality +0.167 (p=.14); vs context -0.233 (p=.003) | NOT ADOPTED (not significant). Noise .25. Picks per selection still <1 on average (23 per session of 30 selections) although the cap was 12: the selection's two conditions (changes next action; not taken in) suppress items. Context assistants see ~20 messages per turn. |
| v4 | relevance is the only criterion: pick every fact or plan that bears on what the person is working on now, whether or not they lean the same way or have had it before (cap 20); the GIVEN BEFORE mark is no longer shown to the selector; reply integrates as in v3 (principle: redundancy is not noise when the receiver has not integrated; the gate's job is relevance, not novelty) | v4 (workspace arm only, same 12 tasks x 2 seeds, 00:00-00:18) | | | 0.667 / 0.71 | | vs v1 +0.042 (p=.35); vs v3 -0.008; vs context -0.242 (p=.006) | NOT ADOPTED. Picks per session 28 (still ~1 per selection). Mid-round accuracy 0.758 (context 0.725) but FINAL 0.667: 29 of 120 people were right at round 3 and wrong at round 6 (18 the other way). Flippers' late picks were 58% "contradicts" (stayers 30%): the selection works against a correct leaning. Labels and reasons also upgrade speculation to fact ("if the road was cleared..." became "Jordan confirms the road was cleared"). |
| v5 | the gate decides relevance only and returns turn ids; no relation labels, no reasons; the assistant integrates the raw attributed text and keeps each item's standing (a report vs a supposition); facts-only rule kept in the gate (principle: the reader does the epistemics with the primary text; a classifier between workspace and reader is a lossy, biased channel) | v5 (workspace arm only, same 12 tasks x 2 seeds, 00:20-00:42) | | | 0.700 / 0.79 | | vs v1 +0.075 (p=.18), plurality +0.208 (p=.09); vs iso +0.558 (p<.001); vs context -0.208 (p=.002) | Best so far; noise down to .13; late flips balanced (18 each way); picks per session 50 (v1 19). Monotone trend: accuracy rises with how much of the workspace reaches the assistant (v1 19 items .625, v4 28 .667, v5 50 .700, context ~100 .908). The selector still returns <2 turns per call when told to include everything that bears. |
| v6 | the gate is a switch: does anything in the workspace bear on this turn at all? If yes, the assistant reads the whole workspace (cap 60 items); if no, nothing. Ask kept. (principle: the only decision a channel should make is whether to open; what passes through is decided by the reader, Hearsay-II broadcast) | v6 (workspace arm only, same 12 tasks x 2 seeds, 00:43-01:01) | | | 0.792 / 0.79 | | vs v1 +0.167 (p=.011); vs v5 +0.092 (p=.12); vs iso +0.650 (p<.001); vs context -0.117 (p=.032) | Significant over v1 and explained (integration of the whole picture). Noise .28. The switch closed on 252 of 696 turns (36%), mostly late turns where the person states a conclusion; people for whom it opened more often were more accurate. |
| **v7** | the switch closes only for greetings, small talk, remarks about the tool, or before the person has said what they are working on; it opens whenever the person is weighing, choosing, asserting a conclusion or about to act (principle: Horvitz 1999, asymmetric cost of acting vs not acting; an unneeded read costs tokens, a missed read can cost the decision) | v7 (workspace arm only, same 12 tasks x 2 seeds, 01:03-01:26) | | | **0.825 / 0.875** | | vs v1 +0.200 (p=.009), plurality +0.292 (p=.021); vs v6 +0.033 (p=.38); vs iso +0.683 (p<.001); vs context -0.083 (p=.13, not significant) | **ADOPTED.** Noise .15. Switch closed on 54 of 696 turns (8%). Facts reached someone 90/94; of people reached, 82% correct (context 91%). Off-task relays 3/10 vs context 10/10. |

## The decision round (registered and run 7 Oct 04:16-04:29)

A protocol step, not a prompt change: in the final round each person is asked to state a
final choice to their assistant. Rationale: a group needs a decision procedure, and the
private setting has no channel in which one forms by itself (four of ten Paralax groups on
the Alsobay task ended with no majority).

| HiddenBench, 24 paired sessions | v7 | v7 + decision round |
|---|---|---|
| individual accuracy | 0.825 | 0.858 (+0.033, p = .36) |
| plurality correct | 0.875 | 0.958 (+0.083, p = .31) |
| sessions with no majority | 0.042 | 0.000 |

Kept as part of the protocol: no cost, removes the splits. On the Alsobay task
(`alsobay_dept_decide`, 10 seeds) it changed nothing: groups choosing Eldoron 40% (v7: 50%),
individual accuracy 0.44 (0.42), splits 2 of 10 (4 of 10). So convergence was not the problem
there; integration is. v8 (scoreboard + decision-time votes) runs next on both benchmarks with
the decision round, as `PARALAX_VARIANT=v8`; the default code stays v7 until adopted.

## Conclusion (7 Oct 2026, 01:30)

The algorithm as adopted (v7), stated generally:

1. The shared global workspace is the ordered record of what every person typed, with author
   and turn id. Assistant text is never in it; nothing is extracted or summarised.
2. Before each reply, the person's assistant asks one background question of the workspace:
   does anything in it bear on what my person is working on, and is my person weighing,
   choosing, asserting or about to act? The switch closes only for greetings, small talk,
   remarks about the tool, and before the person has said what they are working on.
3. When it opens, the assistant reads the whole workspace (the raw attributed text), integrates
   it into one picture organised by the courses of action its person is weighing, keeps each
   item's standing (a report is passed on as that person's report; a supposition is never passed
   on as a fact), and credits by name.
4. It may also ask its person for one fact another person needs (the ask route).
5. When the switch is closed, the assistant says nothing about the others.

What the loop established, each with a paired test on the same 24 sessions:

- Pooling through assistants works: every version beat independent pairs by 48-68 points.
- Accuracy is monotone in how much of the workspace reaches the assistant (v1 19 items/session
  .625; v4 28 .667; v5 50 .700; v6/v7 whole workspace .79/.83; context .91).
- Delivering facts is not the bottleneck; integrating them is. People who received every fact
  were right 54-66% of the time under per-item delivery and 89% under whole-picture integration.
- Relation labels ("contradicts", "supports") and model-written reasons hurt: they push people
  off correct leanings and upgrade suppositions to facts. The reader should get primary text.
- The one thing a gate should decide is whether to open, and it should err open when the
  person is deciding (v6 -> v7: closures fell from 36% to 8% of turns, accuracy .79 -> .83).
- What the gate buys is restraint on off-task turns (3/10 relays vs 10/10).

Limits: 12 tasks, 2 seeds, flash-lite people and flash assistants; seed-to-seed noise of
.15-.38 means differences under ~15 points are not detectable here; HiddenBench is a choice
among options, so open-ended problem solving is untested beyond the scripted scenario; the
whole-workspace read will not scale to large N or long sessions, where a per-item or digest
retrieval returns as a necessary approximation with a cost that this loop has now measured.
