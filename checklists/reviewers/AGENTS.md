# AGENTS.md — Science checklist (reviewers)

For a coding agent helping an assigned **Junior or Senior reviewer** work through BOLD Lab's Science checklist. This is a pre-review to speed up the human reviewer's own pass, not a replacement for it — the assigned reviewer still ticks the real checklist at the paper's card on the [Internal Review Board](https://bold-lab-ai.github.io/bold-os/audit-board.html) and still does the sign-off (In review → Approved, now itself derived automatically from those ticks — see `docs/FIREBASE.md`). This file only covers the Science checklist; Format is a separate pass by the paper's authors — see `checklists/format/AGENTS.md`, not this one.

Read in a skeptical, not confirmatory, mode throughout — you're looking for reasons a claim might not hold, the same posture a human reviewer is expected to bring, not summarizing the paper's own framing of itself back at it.

## What you need before starting

- The full paper PDF, including appendix.
- The linked code/data repo, if there is one and you have access — several items below can't be checked from the PDF text alone.
- A general sense of the venue and subfield this is being submitted to, so "relevant to the target community" (item 4) means something concrete rather than a guess.

## The six items, and how to check each

Work through all six regardless of whether an earlier one raises concerns — report every finding, don't stop at the first problem.

1. **Claimed contributions.** Contributions are stated clearly (ideally a short, explicit list) and checked against the paper's actual evidence — nothing in the abstract or intro claims more than the results show. Check: extract the stated contributions verbatim from the abstract/intro, then for each one find the specific result, theorem, or experiment that's supposed to back it up. Flag any contribution claim with no matching evidence, or evidence that's weaker than the claim's phrasing implies.
2. **Correctness — theoretical claims.** Proofs are correct, with reasonable and clearly-stated assumptions. Check: for every theorem/lemma/proposition, verify the proof actually holds — don't just check it's present. Separately check the assumptions are stated explicitly (not buried or implicit) and are actually reasonable for the claimed setting, not quietly doing most of the work themselves.
3. **Correctness — empirical claims.** Experiments are well-designed with fair, non-strawman baselines, and the results shown actually support the conclusions drawn from them. Check: are the baselines real, current, and fairly tuned (not a weakened version of a competing method)? Do the reported numbers, tables, and figures actually support the paper's stated conclusions, or is there a gap between what's shown and what's claimed? Check for missing error bars/seeds/significance where the claims are comparative.
4. **Impact.** The problem is relevant to the target community, others could plausibly build on it, and the scope of impact is honestly represented — not oversold, not undersold. Check against the actual venue/subfield this is aimed at, not a generic "is this interesting" judgment. Flag both directions: a paper inflating its own importance, and one underselling a genuinely useful result.
5. **Limitations.** Limitations and known failure modes or negative results are disclosed honestly — not buried or omitted. Check: is there an actual limitations section/discussion, not a token sentence? Cross-check the experiments section for any result, caveat, or failure case that's visible in a table or figure but never actually discussed in the text.
6. **Related work & positioning.** Prior work is represented accurately, the contribution is clearly differentiated from the closest prior work, and nothing obviously relevant is missing. Check: do a quick literature check for the 2-3 closest prior works in this specific area — confirm they're cited, described accurately (not strawmanned to make this paper's contribution look bigger), and that the paper's own differentiation claim actually holds up against them.

## Reporting

For each of the six items, give a clear **pass / concern / can't verify** plus the specific page/section/line backing it up — a human reviewer should be able to jump straight to the evidence, not re-derive it. Be concrete about *why* something is a concern (e.g. "Table 3's baseline uses half the training steps of the proposed method" beats "baselines seem unfair"). A "pass" on every item is a legitimate outcome, but don't default to it — a report that never raises a concern isn't doing the skeptical read this is for.

You very likely don't have a signed-in session to the Internal Review Board itself, so you can't tick the boxes directly — hand your report to the human reviewer to tick by hand once they've confirmed it, or, if you're operating inside that reviewer's own already-authenticated browser session, the same pattern `docs/FIREBASE.md` documents for one-off data fixes (a small script against `firebase.firestore()`) applies here too, gated exactly the same way the app itself gates it: only the assigned Junior or Senior reviewer's signed-in email can write their own role's ticks on this paper's card.
