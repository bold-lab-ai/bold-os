# DIFF — implementation vs. BOLDiquette

Every point where the paper-submission tooling in this folder (`how-to-submit-a-paper.html`, `audit-board.html`) differs from **BOLDiquette § ML Conference Cycle**. This is the list to work through when requesting changes to BOLDiquette.

**BOLDiquette source:** <https://docs.google.com/document/d/1xwgzA72U9oSt94E47H39-8vjV0QhxYCfSP_vkY91S5w/edit#heading=h.fw00d94v1wfp> — § ML Conference Cycle (Pre-submission / Post-submission / Arxiv / Publicity / Rebuttal / On Acceptance / Pre-Conference). Text read 2026-09-10.

**Legend**

- **NEW** — process or tooling BOLDiquette doesn't cover at all.
- **DIVERGENCE** — our pages currently say something different from BOLDiquette.
- **PROPOSED** — a change we want made to BOLDiquette; until it lands, the implementation follows BOLDiquette.

---

## 1. Internal Review — NEW

**BOLDiquette:** Pre-submission says only *"Submit a first full draft to the compulsory BOLD PI on your paper 10 days ahead of the final deadline."* No structured runway, no review, no roles, no checklist.

**Implementation:** the pre-submission run is a fixed timeline, and the first full draft goes through a **simulated full peer review** (venues are all similar).

- **8 wk before the deadline** — register the paper (abstract, outline, author list, target venue, compute estimate) on the Internal Review Board.
- **6 wk** — Pitch Day: every paper is pitched to the group.
- **4 wk** — first full draft → Internal Review, worked through by a **junior** and a **senior** reviewer from the pool.
- **2 wk** — final draft, every review comment incorporated.
- **1 wk** — the PI reads the final draft and approves it for submission. That is the PI's only involvement.
- The **reviewer pool** = every paper's authors plus volunteers, with at least one senior.
- 12-item checklist (6 Format, 6 Science; each item folds together several related points to keep the tick count manageable), on every board card's detail page. A **junior** and a **senior** reviewer are assigned per submission on the board; each fills in the checklist. A paper can't be marked **Approved** until both passes are complete.

**Proposed BOLDiquette change:** add a new subsection between Pre-submission and Post-submission (drop-in prose in `proposed-boldiquette-addition.md`). Supersedes the old "first draft to the PI 10 days ahead" line.

## 2. Internal Review Board — NEW

**BOLDiquette:** nothing.

**Implementation:** `audit-board.html`, one board per venue + year. Columns mirror the guide's 9 phases, named past tense for the checkpoint already met to be sitting there: Registered → Pitched → Drafted → Reviewed → PI Approved → Submitted → Posted → Reviews Out → Accepted — each column is an attestation of a real-world checkpoint being met, not a work-in-progress bucket. Within Drafted a card is colour- and badge-coded In review / Changes requested / Approved (derived from the checklist, plus a reviewer-settable flag); the outcomes Accepted / Rejected / Withdrawn are a separate badge, not to be confused with the Accepted column (the final draft actually reaching the venue's own decision). Per-card fields: compute estimate; post-submission — submission link (OpenReview or other), rebuttal deadline, rebuttal doc link, review notes. The venue carries the call for papers and submission-page links, the paper deadline, an optional explicit Pitch Day, and its own dates — reviews released and rebuttal deadline as standard fields, abstract / notification / camera-ready as optional — plus page limit and anonymity. From the paper deadline the board **derives and clearly displays** one chronological deadline list — register (−8 wk), Pitch Day (explicit, or −6 wk), first draft (−4 wk), final draft (−2 wk), PI approval (−1 wk), then the venue's own dates — and exports the whole list as a downloadable **.ics**.

**Proposed BOLDiquette change:** covered by the same draft addition plus its "Addition to Post-submission" block.

**Known limitation (not a BOLDiquette question):** status changes are a free-form dropdown, except the Approved gate (both checklist passes must be complete). Who may move a card / tick which pass is unenforced — see `TODO.md` Permissions.

## 3. Where the project is logged — DIVERGENCE

**BOLDiquette (Pre-submission):** *"add your project 4 weeks ahead of the deadline to the [project tracker] spreadsheet."*

**Implementation (Phase 1):** register the paper on the **Internal Review Board 8 weeks ahead** (title, abstract, authors, venue, compute estimate); the card starts in *Registered*.

**Proposed BOLDiquette change:** replace the project-tracker instruction with the Internal Review Board, and move the timing from 4 to 8 weeks.

## 4. Pre-submission timeline — PROPOSED (implementation is ahead of BOLDiquette)

**BOLDiquette:** register 4 weeks ahead; first full draft to the PI 10 days ahead; clear your calendar for the 4 weeks before the deadline.

**Implementation:** the real timeline (per Mattie, who ran this before) — **8 wk** abstract + outline + compute → registered · **6 wk** Pitch Day · **4 wk** first full draft → Internal Review · **2 wk** final draft with all comments in · **1 wk** PI approval · **0** submit.

**Proposed BOLDiquette change:** replace the Pre-submission timing lines with this runway.

## 5. Who reviews the draft — DIVERGENCE

**BOLDiquette:** *"the compulsory BOLD PI on your paper"* reviews the first full draft.

**Implementation:** the first full draft is reviewed by a **junior** and a **senior** reviewer from the pool (peers). The **PI** is involved only in the week-1 polish.

**Proposed BOLDiquette change:** fold into the new Internal Review subsection (§1).

## 6. Compute estimate at registration — NEW

**BOLDiquette:** no mention of compute at the pre-submission stage.

**Implementation:** an estimate of the compute the paper will need is required at registration (8 weeks out) and stored on the board card.

**Proposed BOLDiquette change:** add "a compute estimate" to what's required at registration.

## 7. Pitch Day — NEW

**BOLDiquette:** no pitch requirement.

**Implementation:** every paper is pitched to the group at a fixed **Pitch Day**, at least 6 weeks before the deadline; a paper that hasn't been pitched doesn't go forward.

**Proposed BOLDiquette change:** add Pitch Day to Pre-submission.

## 8. "On Acceptance" step dropped — DIVERGENCE

**BOLDiquette (On Acceptance):** *"Submit the form to add the paper to our website."*

**Implementation:** the guide has no "On Acceptance" phase. Once BOLD OS is live the project (and its publications) already exist there, and an accepted publication is published to the website automatically — see `TODO.md`.

**Proposed BOLDiquette change:** replace the manual form step with "BOLD OS publishes the accepted publication automatically" once that exists; until then the manual step still applies and the guide is ahead of reality here.

## 9. Presentation format — DIVERGENCE

**BOLDiquette (Pre-Conference):** *"Please use Google Slides for your presentation to facilitate collaboration."*

**Implementation (Phase 9):** slides can be Google Slides **or** an HTML deck — whatever is easiest to build (often with an agent) and share.

**Proposed BOLDiquette change:** loosen to "a format co-authors can collaborate on and exchange easily (Google Slides, an HTML deck, …)".

## 10. Pre-Conference networking — NEW

**BOLDiquette (Pre-Conference):** poster, practice talk, slides format, example posters, "posters are not papers". No networking guidance.

**Implementation (Phase 9):** adds two items — email people you want to meet at the conference at least **3 weeks beforehand** to set up a meeting; and attend as many of the conference's social events as you can (**mandatory**), since they're usually the best networking.

**Proposed BOLDiquette change:** add both to Pre-Conference, including the mandatory framing on social events.

---

## Reconciled — no longer a difference

- **arXiv affiliation.** Guide now uses "BOLD, {University of Oxford / Imperial College / UCL}", matching BOLDiquette exactly (was Oxford-only). *Fixed 2026-09-10.*
- **Roger Grosse attribution.** The guide credits "Roger Grosse" for the loose-ends practice; BOLDiquette has a typo, "Rober Grosse". Editorial only — worth fixing in BOLDiquette when the section is next edited.
