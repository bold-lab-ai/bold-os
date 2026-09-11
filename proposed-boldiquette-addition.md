# Proposed addition to BOLDiquette

Where this goes: inside **ML Conference Cycle**, as a new subsection between **Pre-submission** and **Post-submission** (the paper goes through this from about 8 weeks out, before it's submitted to the venue). It replaces the current Pre-submission line "submit a first full draft to the compulsory BOLD PI 10 days ahead of the deadline".

Voice/format matched to the surrounding BOLDiquette text. Where our implementation has moved ahead of BOLDiquette, the differences are tracked in `DIFF.md`; the ones that touch this section are noted inline below.

---

### Internal Review (before the paper goes anywhere near the venue)

The pre-submission run has fixed milestones, all counted back from the venue's paper deadline:

- **8 weeks** — register the paper: title, abstract, a paper outline, the author list, the target venue, and an **estimate of the compute it will need**. No full text yet.
- **6 weeks** — Pitch Day. Every paper is pitched to the group; a paper that hasn't been pitched by this point doesn't go forward.
- **4 weeks** — there is a **first full draft**. It goes through **Internal Review** — a simulated full peer review (the venues are all similar), worked through by a **junior** and a **senior** reviewer drawn from the pool. The pool is every paper's authors plus volunteers, with at least one senior.
- **2 weeks** — the **final draft**, with every review comment incorporated.
- **1 week** — the PI reads the final draft and approves it for submission. This is the PI's only involvement in the process.

The Internal Review checklist has two parts, Format and Science (below). Each is filled in twice — by the assigned junior reviewer and the assigned senior reviewer. A paper can't be marked **Approved** until both passes are complete. None of this is a review by the venue's actual reviewers — it all happens before that, to catch anything that would get the paper rejected (or embarrassed) for reasons that had nothing to do with them.

Track the paper on the **Internal Review Board** — one board per venue and year, with a column for each of these milestones plus Submit, arXiv & Publicity, Rebuttal, and Pre-Conference.

**Format checklist:**

- *Mandatory sections & parts* — every section the call for papers requires is present (e.g. limitations, broader impact / ethics statement); any mandatory checklist or disclosure form is filled in, not left as a template; everything the main text references in the appendix actually exists there.
- *Length & page limits* — main paper within the page limit; section-specific limits respected (abstract word count, appendix page count, etc.); margins/font/spacing haven't been manually shrunk to fit more in.
- *Double-blind anonymity* — no author names or affiliations anywhere, including acknowledgments; PDF metadata doesn't leak identity; linked code/data repos are anonymized; self-citations are third person.
- *Template & formatting* — latest official template, not a copy from a previous year; PDF compiles cleanly; fonts embedded and page size correct.
- *Policy compliance* — not in violation of the venue's dual-submission policy; arXiv/preprint posting follows the venue's timing policy.

**Science checklist:**

- *Claimed contributions* — the paper states its contributions clearly (ideally a short, explicit list); every claim is checked against the specific evidence for it, not taken on faith; nothing in the abstract/intro claims more than the results show.
- *Correctness* — proofs are correct with reasonable, clearly-stated assumptions; experiments are well-designed and test what's claimed; baselines are fair, not strawmen; results actually support the conclusions drawn.
- *Impact* — the problem is relevant to the target community; others could plausibly build on it; the scope of impact is honestly represented. Doesn't require state-of-the-art results.
- *Limitations* — stated honestly, not buried; known failure modes are disclosed. Disclosing these is a point in the paper's favor, not against it.
- *Related work & positioning* — prior work represented accurately, not mischaracterized to look weaker; the contribution is clearly differentiated from the closest prior work.

*(Reference implementation of both checklists, kept in sync with this section: the Internal Review Board tool.)*

---

### Addition to Post-submission

Once submitted, the Internal Review Board also tracks the paper past that point:

- **Rebuttal** — link to the submission system (OpenReview or other), rebuttal deadline, a link to the rebuttal drafting document, and free-text review notes (scores, summary, whatever's worth remembering) all live on the paper's card.
- **Accepted / Rejected** — final status once the venue decides.

---

*arXiv affiliation — reconciled:* the guide now uses `"BOLD, {University of Oxford / Imperial College / UCL}"`, matching the current BOLDiquette text. No change needed to this section.
