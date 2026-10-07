# Agent observability, expert review, and control over attention

Research note and TeXRA design proposal, 7 October 2026.

## The problem is a broken connection between intent, evidence, and attention

An agent can produce a detailed execution trace while leaving its collaborator unable to answer the important
questions: **Is it still solving the right problem? What has become justified? What needs my judgment? Can I
safely stop checking?** These questions concern different things. A tool trace records actions. An argument
explains why those actions and their results support the objective. A collaboration protocol determines when a
person must engage. Improving the first does not automatically improve the other two.

The experience of waiting through a three-hour run is therefore not just a latency problem. The person has
delegated execution without necessarily delegating responsibility or knowing when responsibility will return.
Checking repeatedly interrupts other work. Not checking can increase the cost of reconstructing context or
correcting an early mistake. An interface that merely exposes more activity can make this worse.

My recommendation is to build **review around decisions and evidence, and make the timing of review
explicit**. Keep execution logs available underneath this view. Judge the system by accepted work, the human
effort required to establish its quality, and the person's ability to work or disengage on their own schedule.

This is a curated review, not a systematic search or an exhaustive account of work published by this date.
Primary papers, author pages, and official specifications were retrieved directly. Full texts were examined
for Sidekick, AdaLens, AgentGUI, the developer-oversight study, the Observability Gap paper, the human–AI
meta-analysis, Horvitz, and Mark et al. The bibliography distinguishes experimental findings, exploratory
studies, and standards. Several particularly relevant systems are recent preprints; their evidence should not
be treated as settled practice.

## What the literature establishes

### Human participation is work, not a free source of correctness

Dhanorkar, Passi, and Vorvoreanu interviewed 17 experienced developers using software agents. They identified
oversight before execution, during planning, during execution, and after completion. Reviewing output is only
one part of this work. Their account also documents shortcuts such as treating passing tests as guarantees of
correctness. This is an exploratory interview study, not a controlled measurement of productivity, but it
directly challenges the assumption that human oversight means an inexpensive final approval.[^oversight]

Vaccaro, Almaatouq, and Malone's preregistered meta-analysis covered 106 experiments and 370 effect sizes from
studies published between January 2020 and June 2023. Human–AI combinations improved on humans alone on
average, but performed worse than the better of the human-only and AI-only alternatives on average. Results
differed by task type. This does not establish that current coding agents make collaboration worse: the
studies predate much of today's agent tooling. It establishes a crucial evaluation requirement: **measure the
combined workflow against both relevant alternatives**, rather than assuming that adding a person necessarily
improves an AI system.[^meta]

This also connects to software engineering's SPACE framework: activity and throughput alone are inadequate
accounts of developer productivity. Satisfaction and well-being, performance, activity, communication and
collaboration, and efficiency and flow provide different perspectives. Counting tool calls or generated code
is particularly weak evidence of useful agent collaboration.[^space]

### Some recent systems directly address context switching and abstract oversight

**Sidekick — Chang et al., 2026.** This is the closest match to the waiting-and-switching problem. It
distinguishes background awareness, context resumption, and foreground interaction. Ambient state cues support
background work; summaries and replays help the person return. A study with 30 participants compared
interfaces while participants solved arithmetic problems and delegated spreadsheet work to a computer-use
agent. Sidekick improved multitasking performance over the tested text-based alternatives. The experiment used
short, eight-minute sessions and deliberately imperfect agent behavior; it does not demonstrate recovery from
three-hour research runs. The transferable idea is to design the return to work as carefully as the
notification that work has finished. Not everyone liked every feedback modality.[^sidekick]

**AdaLens — Liu et al., 2026.** This system represents ongoing data analysis through a storyline connecting
plans, execution, intermediate findings, and data-column involvement. Steering is grounded in these visible
analytical elements, including managing individual analytical threads. Two case studies and a 12-participant
study support its usability; the reported mean SUS score was 87.08. The task phase lasted 15 minutes, and the
study did not establish a comparative improvement in scientific correctness or long-term productivity. It
nevertheless provides a concrete design precedent for inspecting ideas and evidence above the level of
individual tool calls.[^adalens]

**AgentGUI — Zhao et al., 2026.** This interface supports observing and steering concurrent, long-running
agent sessions. In an eight-participant, counterbalanced study, participants answered questions about recorded
trajectories 38% faster than with the tested baseline, averaging 90 rather than 145 seconds per question. That
measures trace comprehension and information lookup, not the cost of managing a full working day. Its separate
automated-steering experiments should not be conflated with the human-interface result. The useful lesson is
to measure whether someone can reconstruct the relevant state accurately, rather than whether the dashboard
looks informative.[^agentgui]

**The Observability Gap — Wang and Wang, 2026.** In a Blender scene-generation setting, output-only human
feedback did not reliably identify underlying code and execution problems. A diagnostic intervention supplying
code-level knowledge restored convergence in the investigated setting. This CHI workshop paper is a narrow
case study, not evidence that output feedback generally fails. It gives a useful mechanism: different hidden
failures can produce similar visible symptoms, so a human needs access to intermediate state that
distinguishes the competing explanations.[^gap]

Together, these papers suggest that a better interface needs more than a polished transcript: a compact
representation of the work's meaning, links back to evidence, explicit steering targets, and inexpensive
context resumption. They do not yet establish a single best interface or a universal productivity metric.

### An agent's explanation is not the same thing as an audit trail

Turpin et al. showed that chain-of-thought explanations could rationalize answers influenced by biasing inputs
without reporting those influences. Lanham et al. intervened on reasoning text and found substantial variation
in how much the answer actually depended on it. These studies concern particular models and tasks; they do not
imply that every explanation is useless. They do rule out treating a plausible narrative as sufficient
evidence of the actual computational cause of an answer.[^turpin][^lanham]

For TeXRA, an abstract view should therefore expose **declared objectives, assumptions, proposed decisions,
observed results, checks, and human judgments**. It should not promise access to the model's true internal
reasoning. Distinguish:

- “The agent says this tool call tests assumption A.”
- “The runtime recorded this command, input revision, result, and exit status.”
- “This checker established property P under assumptions A and B.”
- “An expert accepted the interpretation for the stated objective.”

These are different claims with different authorities. A second model can help challenge an interpretation,
but its agreement is not an independent formal guarantee.

### The timing problem predates LLMs

Horvitz's mixed-initiative principles explicitly consider uncertain user goals, attention, timing, the costs
of acting or asking, and recovery from mistaken automation. They support choosing when to involve a person
according to the value of intervention and the cost of interruption, rather than asking whenever the agent
encounters uncertainty.[^horvitz]

Mark, Gudith, and Klocke found that participants compensated for interruptions by working faster, while
reporting greater stress, frustration, time pressure, and effort. This matters because a system can appear
faster while making the working experience worse. The study was not about LLM agents and does not justify a
universal “minutes lost per interruption” constant.[^mark]

The design implication is a tradeoff. Frequent checking can reduce undetected drift but increase
fragmentation. Infrequent checking can protect attention but increase reorientation and repair costs. Review
intervals should depend on uncertainty, reversibility, and the consequences of waiting—not simply on how often
the model produces another message.

## What to borrow from software engineering

### Record execution facts at their source

Distributed tracing connects operations through identifiers, timing, parentage, and outcomes. OpenTelemetry's
GenAI conventions cover model and agent operations and tool execution. As checked on 7 October 2026, the GenAI
specifications have moved to a dedicated repository and the examined span conventions are marked
**Development**. Pin an adopted version and map TeXRA's domain events to it; do not let a changing telemetry
schema become the application's storage contract.[^otel]

A tool receipt should connect:

1. The requested operation, arguments, originating response, call ID, and attempt.
2. The input artifact revisions and execution context relevant to reproducing it.
3. The applicable decision or permission, where one is required.
4. Start, finish, cancellation, failure, or explicitly unknown outcome.
5. Returned content, changed artifacts, and independently measured checks.
6. The decision or claim this result is supposed to inform.

Keep sensitive payloads under appropriate access controls; redaction and truncation should be visible facts. A
redacted receipt can still establish that an attempt occurred. A successful process exit does not establish
that its output is correct or useful.

### Make the argument connecting evidence to intent explicit

W3C PROV separates entities, activities, and responsible agents, with relations such as derivation and
attribution. This provides a vocabulary for connecting artifacts to the actions and inputs that produced them.
Provenance establishes lineage; it does not establish truth.[^prov]

Goal Structuring Notation represents claims, the argument relating them, context and assumptions, and
supporting evidence. It is a useful precedent for an expert-facing view of a research agent's work. A
well-formed assurance argument still needs substantive review: drawing an edge from a test to a claim does not
prove the test establishes that claim.[^gsn]

Design by contract offers a complementary pattern: state what must hold before an operation, what it
establishes, and which invariants it preserves.[^contract] For agent work, contracts should include semantic
obligations as well as execution conditions. For example, “the proof compiles” and “the proved statement is
the intended theorem” are separate obligations. Tests can establish a precisely scoped property while leaving
the second unresolved.

The useful abstraction is thus a set of **reviewable claims with evidence and outstanding obligations**, not
an automatically generated success story.

## A proposed TeXRA interface

### Group the work by questions and decisions

The primary unit should be the question being answered or the claim being established. Sessions and agents
remain provenance and execution contexts. This prevents a person from having to remember which chat contains
the relevant assumption or result.

A compact overview for one question could show:

```text
Question: Does the improvement survive evaluation on unseen projects?

Current conclusion: Not established.
Evidence: Experiment 14 improved the aggregate score.
Open assumption: Repository overlap does not explain the improvement.
Next check: Evaluate a split grouped by repository.
Decision needed: Confirm that this is the intended generalization target.
Changed since your review: Evaluation split changed; prior result is now provisional.
```

Each statement links to its source artifact, tool receipt, or explicit human decision. Use distinct states
such as proposed, observed, checked, accepted, refuted, and stale. “Checked” must name the checker and its
scope; it must not silently become “accepted.”

The default view can be an outline or a short table. An enormous dependency graph would introduce another
navigation burden. Reveal dependencies when a person inspects a claim, changes an assumption, or asks what a
result depends on.

### Show semantic changes since the last review

The return view should answer:

- What objective, assumption, method, or conclusion changed?
- What evidence appeared, and what earlier evidence became stale?
- Which artifacts changed?
- What is blocked on my judgment, and what happens if I defer?

A file diff remains necessary, but it cannot by itself show that an evaluation criterion was weakened or a
theorem's hypothesis changed. Conversely, a model-generated semantic diff can miss or misdescribe a change.
Present it as an indexed summary with source links and mechanically recorded revisions, not a replacement for
inspection.

Acceptance should attach to a specific claim and evidence revision. If an input, assumption, or checker
changes, mark affected judgments for revalidation. Preserve the old argument so the human can understand why
the conclusion changed.

### Make interventions precise and acknowledge when they take effect

Useful operations include rejecting an assumption, requesting a discriminating experiment, narrowing a claim,
freezing a validated artifact, pausing a branch, or approving a specified next step. Each intervention needs a
stable target. “Try again” in a different chat is a poor substitute.

Distinguish an instruction being **queued**, **received**, and **applied**. If the agent is in a tool call,
explain the next safe point at which the change can take effect. Show the resulting plan change. This makes
steering auditable and prevents the appearance of control when the instruction has not yet influenced
execution.

### Use the flexible workspace for inspection, not just parallel chat

Keep Agent, Decisions, Artifacts, and Execution as movable tabs. A useful working arrangement is the current
decision beside the relevant document or code, with tool receipts available on demand. A person should be able
to open one piece of evidence without losing the decision they were reviewing.

The project overview should identify work needing attention and the next agreed review time. Execution state
and task acceptance state must remain separate: an agent can stop while the task is unfinished, and a
completed execution can still await review.

## A workflow that lets the human disengage

At the start of substantial work, agree on the objective and acceptance conditions, the decisions the agent
may make, the conditions that require human judgment, a resource limit, and a review schedule. These need not
require a long form; project defaults and a short confirmation of material differences can carry most of the
policy.

For example, during a three-hour run:

- Review the proposed method early, while correcting a mistaken objective is inexpensive.
- Then reserve two brief review windows rather than repeatedly checking progress.
- Between windows, continue authorized independent work and queue nonurgent questions.
- If a necessary decision cannot wait, identify the blocked consequence and escalate under the agreed policy.
- If the person is unavailable, checkpoint or pause the dependent branch. Do not invent approval or silently
  substitute a different objective.

The schedule is a proposal, not a prediction that the agent will finish at a particular time. Show uncertainty
in completion estimates and separate “ready for your review” from “you must respond now.”

On returning, the human should receive a short packet containing the semantic changes, evidence, unresolved
disagreement, and a concrete decision. A packet should remain usable if another expert takes over or the
original person returns tomorrow.

This is not an argument for keeping people constantly occupied. A protected interval can support unrelated
work, a break, or leaving the computer entirely. The product should make that choice possible, not treat
unobserved time as wasted time.

## Metrics: evaluate quality, coordination, and freedom from monitoring

There is no single validated metric in the reviewed work that captures the whole problem. Use a small
scorecard. Keep published measures separate from the following proposed adaptations.

### Established measures worth carrying over

- **Task performance against relevant baselines:** human alone, agent alone, and the combined workflow. The
  human–AI meta-analysis makes this comparison especially important.[^meta]
- **Trace comprehension:** time and accuracy for answering consequential questions about a run, as in
  AgentGUI.[^agentgui]
- **Dual-task performance and workload:** Sidekick measures the person's own task alongside delegated work and
  uses an adapted NASA-TLX questionnaire. Report any adaptations rather than calling all variants the same
  scale.[^sidekick]
- **Usability:** SUS, as used by AdaLens, can diagnose usability but is not a proxy for correct research
  output.[^adalens]
- **Multiple productivity dimensions:** use SPACE to resist optimizing activity or speed at the expense of
  quality, collaboration, or well-being.[^space]

### Proposed operational measures for TeXRA

- **Accepted progress per expert minute:** independently assessed useful progress divided by active human
  time, including setup, review, reorientation, and repair.
- **Reorientation time:** time from reopening a work item to correctly stating its objective, current
  conclusion, unresolved issue, and next decision.
- **Unplanned attention demand:** unscheduled review requests and self-initiated monitoring checks per working
  hour, reported separately.
- **Protected interval success:** proportion of agreed attention-free intervals completed without a required
  intervention; pair with a short report of whether the person felt able to stop checking.
- **Decision latency:** time from a necessary decision becoming actionable to its resolution and application;
  separate scheduled waiting from unexpected delay.
- **Review backlog:** unreviewed consequential changes, weighted by dependency impact and age; avoid counting
  every log line.
- **Semantic drift detection:** delay and downstream rework between an incorrect assumption or objective
  change and its detection, on tasks where ground truth is annotated.
- **Evidence integrity:** unsupported or stale claims accepted; supported claims incorrectly rejected;
  source-link accuracy and completeness.
- **Execution accountability:** fraction of attempted tool operations connected to an intent and a settled
  result or an explicitly unresolved outcome.
- **Recovery cost:** expert time and discarded work needed after a failure, rejected conclusion, or handoff to
  another person.

These measures need clear denominators and independent quality assessment. A large volume of trivial accepted
subtasks must not inflate “progress.” Fewer interruptions can reflect either better autonomy or missed
problems. Inactive time does not prove that someone relaxed. Read the measures together.

One useful derived capacity check is:

```text
attention demand = sum over agents(
    review requests per minute × (review minutes + reorientation minutes)
)
```

If this exceeds one for a single reviewer, the review queue cannot remain stable under those average
assumptions. Being below one is only a necessary capacity check: bursty or correlated requests, deadlines, and
the person's other work can still make the system unusable. This is a queueing-based design approximation, not
a validated LLM collaboration score. Its purpose is to show why adding agents can reduce effective throughput.

Likewise, compare combined quality with the better solo baseline under a stated time and resource budget.
Report both quality and human time rather than hiding the tradeoff in one composite score.

## What TeXRA already has, and what is missing from the inspected contracts

The code inspection on this date found a useful foundation:

- `src/shared/schemas/sessionEvent.ts` has durable lifecycle, plan, request-opened/request-decided, and
  queued/consumed follow-up events.
- `src/shared/schemas/runHistoryEvent.ts` records tool intents, attempts, permission bindings, and results
  with explicit dispositions. This is stronger than reconstructing execution state from English log messages.
- `src/shared/schemas/progressView/data.ts` exposes tool input, output, summaries, errors, exit codes, and
  status for display.
- `src/transcript/traceDocumentSchema.ts` and `traceAssembler.ts` provide a display-event export. That export
  is deliberately different from private runtime history.

The inspected schemas do not provide a first-class representation of versioned claims, assumptions, supporting
evidence, or expert acceptance. `ConversationProgressSchema` currently counts tool calls. `PlanSchema`
deliberately stores a plain objective document instead of structured steps.

**Do not restore a rigid step schema merely to draw a progress graph.** Keep the readable objective and add an
optional projection of decisions, evidence, and obligations, grounded in durable events. Reuse the existing
intent/result and request/decision authorities. Extend display contracts deliberately; do not expose private,
unredacted run history directly to the renderer. The June trace architecture document predates the current
schema organization, so these recommendations are based on the inspected code rather than treating that
document as the current implementation.

A practical implementation order is:

1. Add reliable source links and a “since your last review” view over existing events and artifact revisions.
2. Introduce versioned claims and assumptions with evidence links and explicit human acceptance.
3. Add review scheduling, precise steering acknowledgments, and branch-level waiting.
4. Evaluate before adding more elaborate graphs, automated reviewers, or notification channels.

This note proposes those changes; the UI fixes delivered alongside it do not implement this observability
system.

## An experiment that would answer the research question

Compare three conditions: the current transcript, a compact evidence-and-decisions view, and the same view
with scheduled review plus context-resumption support. Hold the agent backend and information available
constant when testing the interface. Separately evaluate live steering, because it changes the subsequent
trajectory.

Use counterbalanced tasks with domain experts, not only interface novices. Include tasks with misleadingly
successful tool execution, stale evidence, a changed acceptance criterion, conflicting findings, and an
ambiguous decision requiring expertise. Blindly score final artifacts against criteria fixed before the run.
Log criterion changes rather than allowing them to create apparent success.

Measure accepted quality, expert time, review accuracy, reorientation, unplanned checks, protected intervals,
and workload. Use short controlled sessions to isolate mechanisms, followed by a multi-day field study with
genuinely long runs and real handoffs. The short studies in the reviewed literature cannot settle the
three-hour disengagement question.

The central research question is:

**Can evidence-linked semantic review and explicit review timing reduce unplanned human attention without
lowering the quality of accepted work or delaying consequential error detection?**

That question treats the human's time and agency as design objectives, while preserving accountability for
what the agent actually does.

## Sources

[^sidekick]:
    Ruei-Che Chang, Wenqian Xu, Dingzeyu Li, Bryan Wang, and Anhong Guo (2026). _Sidekick: Designing
    Communication for Effective Multitasking with Computer Use Agents_.
    [Primary full text](https://arxiv.org/html/2607.17527v1). Controlled study, N=30; see Sections 5 and 7.

[^adalens]:
    Yangtian Liu et al. (2026). _AdaLens: Interactive Storyline for Monitoring and Steering Long-Running
    Agentic Data Analysis_. [Primary full text](https://arxiv.org/html/2608.17834v1). Preprint; case studies
    and usability study, N=12.

[^agentgui]:
    Xuan Zhao, Jiwoong Sohn, Qinyue Zheng, and Michael Moor (2026). _AgentGUI: An Interface for Observing and
    Steering Long-Running AI Agents_. [Primary full text, version 2](https://arxiv.org/html/2607.26300v2).
    Preprint; trace-comprehension study, N=8; inspect the analysis and limitations, including exclusions.

[^oversight]:
    Shipi Dhanorkar, Samir Passi, and Mihaela Vorvoreanu (2026). _Human oversight of agentic systems in
    practice: Examining the oversight work, challenges, and heuristics of developers using software agents_.
    [Primary full text](https://arxiv.org/html/2606.05391v1). Exploratory interviews, N=17; preprint.

[^gap]:
    Yinghao Wang and Cheng Wang (2026). _The Observability Gap: Why Output-Level Human Feedback Fails for LLM
    Coding Agents_. [Primary full text](https://arxiv.org/html/2603.26942v1). CHI 2026 Workshop on Human-Agent
    Collaboration; Blender case study.

[^meta]:
    Michelle Vaccaro, Abdullah Almaatouq, and Thomas Malone (2024). _When combinations of humans and AI are
    useful: A systematic review and meta-analysis_. Nature Human Behaviour.
    [Publisher full text](https://www.nature.com/articles/s41562-024-02024-1). DOI:
    10.1038/s41562-024-02024-1.

[^turpin]:
    Miles Turpin, Julian Michael, Ethan Perez, and Samuel R. Bowman (2023). _Language Models Don't Always Say
    What They Think: Unfaithful Explanations in Chain-of-Thought Prompting_.
    [Primary paper and abstract](https://arxiv.org/abs/2305.04388).

[^lanham]:
    Tamera Lanham et al. (2023). _Measuring Faithfulness in Chain-of-Thought Reasoning_.
    [Primary paper and abstract](https://arxiv.org/abs/2307.13702).

[^horvitz]:
    Eric Horvitz (1999). _Principles of Mixed-Initiative User Interfaces_. CHI, pp. 159–166.
    [Author's paper](https://erichorvitz.com/chi99horvitz.pdf). DOI: 10.1145/302979.303030.

[^mark]:
    Gloria Mark, Daniela Gudith, and Ulrich Klocke (2008). _The Cost of Interrupted Work: More Speed and
    Stress_. CHI. [Author-hosted paper](https://www.ics.uci.edu/~gmark/chi08-mark.pdf). DOI:
    10.1145/1357054.1357072.

[^prov]:
    W3C (2013). _PROV-DM: The PROV Data Model_. [W3C Recommendation](https://www.w3.org/TR/prov-dm/).
    Provenance model, not an experimental result.

[^gsn]:
    Safety-Critical Systems Club. _Goal Structuring Notation Community Standard_, version 3.
    [Official standard page](https://scsc.uk/gsn-standard). A notation for assurance arguments, not a
    guarantee that an argument's claims are true.

[^otel]:
    OpenTelemetry. _Generative AI spans_, retrieved 7 October 2026.
    [Official specification source](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md).
    Examined status: Development. This is an evolving specification.

[^space]:
    Nicole Forsgren, Margaret-Anne Storey, Chandra Maddila, Thomas Zimmermann, Brian Houck, and Jenna Butler
    (2021). _The SPACE of Developer Productivity: There's more to it than you think_. ACM Queue 19(1), pp.
    20–48.
    [Authors' publication page](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/).

[^contract]:
    Bertrand Meyer (1992). _Applying “Design by Contract”_. Computer 25(10), pp. 40–51. DOI:
    [10.1109/2.161279](https://doi.org/10.1109/2.161279). Bibliographic record verified; used for the
    established contract principle, not a new empirical claim about agents.
