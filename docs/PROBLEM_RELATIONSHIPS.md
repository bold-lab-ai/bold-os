# Proposed Problem Bank family tree

Use a directed acyclic graph for the research hierarchy. Show it as an expandable tree under **By objective**. A problem can help solve several broader problems. Give it one ID and one detail page, whichever path a reader follows.

## What a link means

- **Contributes to** links a problem to a broader problem or a lab objective. It means “Solving this would help solve that.” For example, estimating price response after a trade could help both market simulator evaluation and trading cost estimation.
- **Related to** connects problems when neither is broader. Show these links on the detail page. Keep them out of the tree. Two problems that share a dataset can be related without sharing a scientific objective.
- Use the three pillars in the [BOLDiquette, Research Pillars](https://bold-lab-ai.github.io/bold-os/boldiquette.html#afchbwgz) as starting objectives. Keep a reference to that section with each pillar. Changes to the lab’s pillars go through handbook review. Give each additional moonshot its own name and stable ID. Offer controls on BOLD OS to manage these objectives. A name change should preserve every link.
- Keep project links and verifier releases on their existing problem record. A relationship between problems does not transfer a verifier or its validation status.

## What a researcher sees

1. On **Add problem** and **Edit problem**, ask “Which broader objective or problem would this help solve?” Offer a searchable picker with multiple selections. Search across active problems at every verifier stage. Put optional **Related problems** below it.
2. On a problem page, show **Contributes to**, **Problems that contribute to this**, and **Related problems**. Each title opens the corresponding entry.
3. In **By objective**, expand one branch at a time. If a problem appears under two objectives, both entries open the same page. Keep problems without a path to an objective visible under **Unclassified**. Existing problems can be classified as their owners revisit them.

## How to implement it

Keep problems in `problemBank`. Add Firestore collections for objectives and relationships. Identify each endpoint by type and stable ID. Store each relationship once. A reverse lookup gives the list of narrower problems. For a symmetric **Related to** link, store the two IDs in a consistent order.

Use the existing Problem Bank service for reads and writes. Follow the BOLDiquette’s [access rules](https://bold-lab-ai.github.io/bold-os/boldiquette.html#access). Apply the bank’s edit permissions and record who changed each link and when. In the same transaction as the write, check that both endpoints exist and are active. Reject self-links, duplicates, and any **Contributes to** link that closes an ancestry loop. Serialize hierarchy edits with a shared revision document so simultaneous edits cannot create a loop. Keep archived records in history.

Test a problem with two parents, an existing unclassified problem, an archived parent, an unauthorized edit, and two simultaneous edits that together would form a cycle. Confirm that changing a relationship preserves the problem’s projects and pinned verifiers.

## Draft for the BOLDiquette

Place this text after **Inspiration** in **Research Project Lifecycle → Developing a BOLD project → Think**. Submit it as a proposed change when the feature is ready. A different PI or admin reviews it through [the BOLD OS change process](https://bold-lab-ai.github.io/bold-os/boldiquette.html#0yzbf2xo).

### Open problems and benchmarks

Record an open research question in the [Problem Bank](https://bold-lab-ai.github.io/bold-os/problems.html). Name the person who defined it. Explain why it matters, what makes it difficult, and what the strongest existing methods can do. Link to earlier work so others can trace the idea.

Which larger question would an answer help solve? Link the problem to any relevant [research pillar](https://bold-lab-ai.github.io/bold-os/boldiquette.html#afchbwgz), moonshot, or broader problem. One problem can serve several objectives. Use **Related to** when two problems share an idea or method. You can add these links later.

When a project starts, select its open problem and follow the [project registration steps](https://bold-lab-ai.github.io/bold-os/boldiquette.html#research-project-lifecycle) before results. A question can be recorded before anyone starts a project or builds a verifier.

To record how you will test a solution, open the problem and choose **Add verifier**. If you already use a benchmark, open **Research → Benchmarks** and start in **AutoKaggle Lite** with its paper, code, or scoring instructions. Record the source and evaluator version so others can trace the result. Each verifier has its own checks and evidence.
