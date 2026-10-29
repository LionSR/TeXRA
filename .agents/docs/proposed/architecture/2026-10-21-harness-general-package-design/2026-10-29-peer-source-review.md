---
created: 2026-10-29
status: proposed
---

# A cleaner harness: source review of TeXRA, pi-durable, and DeepSeek

TeXRA should keep its history-driven run program, SQLite store, and Effect
resource management. The most useful changes are to give each lifecycle
decision one owner, make input receipts describe an actual result, and make
permission refer to the exact operation executed. These changes remove reasons
for callers to reconstruct what happened. Moving files or reducing exports
does not, by itself, achieve that result.

This review supports the
[general-package proposal](../2026-10-21-harness-general-package-design.md).
It examines the comparison titled **Harness 对比 pi-durable 与 DeepSeek Harness**
and the release proposals against implementation, rather than treating either
peer as a complete design to import.

## Scope and revisions

| Source            | Revision examined                          | Qualification                                                                        |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| TeXRA             | `66d165b77de80d6ac102bc79a5aa3a84e781429e` | Main checkout; runtime code was not changed by this review.                          |
| pi                | `c3d8ce44d3231c7e46071d2d859f41ca7d39d21b` | Includes unreleased durable-package changes beyond 1.4.0.                            |
| DeepSeek Harness  | `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` | Minimal SDK and richer approval/subagent profiles are distinguished.                 |
| TeXRA release PRD | `7d530121bc451ffe4c63847f298eeac9140b9d22` | Separate `prd-update` worktree, read on 29 October; proposals changed during review. |

The source examinations are recorded separately for
[pi](2026-10-29-pi-source-review.md) and
[DeepSeek](2026-10-29-deepseek-source-review.md). Links below pin source revisions;
recommendations describe intended contracts, not already implemented behavior.

### Changes checked before publication

The findings below record the revisions in the table. By main
`863440c0ee399f99e23f9ca82165a1ef4d7996a9`, the observation-only `Run`
([#14395](https://github.com/LionSR/TeXRA/pull/14395)), the smaller lifecycle
report ([#14396](https://github.com/LionSR/TeXRA/pull/14396)), one session-approval
request ([#14397](https://github.com/LionSR/TeXRA/pull/14397)), direct follow-up
outcomes ([#14399](https://github.com/LionSR/TeXRA/pull/14399)), and plugin-owned
plan facts ([#14402](https://github.com/LionSR/TeXRA/pull/14402)) had merged.
Those reductions are prerequisites for the remaining work, not new proposals
in this review.

The release PRD at `60a45ea469a99a2b359fb32e195d982d34538c0c` incorporates the
distinction between execution ownership and parentage, the controls-only
finalization correction, and acceptance scenarios R20–R24 for receipts, retry,
rewritten tool input, activation isolation, and publication failure.
These are specification changes; they do not establish that the corresponding
runtime behavior and release acceptance are complete.

## 1. The important differences are semantic

| Question                           | pi-durable                                                                                             | DeepSeek Harness                                                                                | Consequence for TeXRA                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| What owns execution?               | A session scheduler controls task validity, ownership, and completion.                                 | An agent machine reserves one active driver and manages its shutdown.                           | Keep one local execution owner, implemented with Effect. Import neither peer's scheduling framework. |
| What does sending input return?    | A persistent submission whose placement and result are distinct; several inputs may share an answer.   | An input ID; SDK completion observes subsequent activity until root idle.                       | Return an identifiable receipt whose result can be recovered from history.                           |
| What does approval authorize?      | Tool hooks may rewrite arguments before execution intent is recorded.                                  | Arguments are copied and frozen before permission; pre-execution decisions cannot rewrite them. | Preserve original input for replay identity and authorize the final validated input.                 |
| What survives interruption?        | Task and submission records support recovery; unsafe effects are not blindly repeated.                 | Checkpoints precede dispatch; incomplete tool history is repaired conservatively.               | Preserve TeXRA's durable requests and explicit replay policy.                                        |
| How is child completion delivered? | Ownership and stable submission identities support recovery; callers still supply relevant identities. | Child persistence and notification to the live parent are separate operations.                  | Preserve the transaction relating a child result to its parent's input.                              |

These are differences in guarantees, not a ranking by code size. pi's short
`startRun` delegates to a 2,528-line scheduler. The comparison assigns that
scheduler to its storage category, while TeXRA's lifecycle work is distributed
differently. The reported loop ratio therefore does not compare equal
responsibilities. Simply adding one file to the denominator would not repair
the comparison either.

## 2. Give execution one owner without inventing another engine

The earlier proposal `Root | Child | Resume | Hold` combines independent
properties: a child can be resumed, and holding a database claim does not say
who its parent is. The revised PRD now recognizes this. Keep the persistent
parent relation in history and let an activation mean one period of local
execution. Resume reconstructs that execution; it is not another kind of
owner. TeXRA already starts child fibers from the session context, because
logical parentage is data rather than fiber ancestry.
[Current registry](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/runRegistry.ts#L69-L132).

pi's stronger lesson is that execution ownership constrains every later
operation. Its scheduler checks invocation validity again when a queued write
actually runs. A handler returning does not finish its parent while owned
foreground work remains. DeepSeek likewise reserves its active driver before
asynchronous work begins and rechecks driver identity when waiting for idle.
[pi scheduler](https://github.com/earendil-works/pi/blob/c3d8ce44d3231c7e46071d2d859f41ca7d39d21b/packages/durable/src/harness/scheduler.ts#L2329-L2352),
[DeepSeek agent](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/agent-loop/src/agent.ts#L170-L258).

For TeXRA, the existing session runtime should own registration, execution,
the claim, and release. Its cleanup must also cover a launch rejected before
its fiber starts. Preserve the exclusion between successive activations and
the existing checks on writes. A process's claim is not itself an activation
identity. No reachable stale-write defect was reproduced here; explicit
activation checks are needed only if the refactoring removes the exclusion
that currently supplies the guarantee.

The durable consequence of stopping should have one decision owner. There
is already one `finalizeRun` writer. The remaining simplification is to remove
independent interpretations of stopping from root launch, child launch,
resume, inactive-run cancellation, and shutdown.
[End writer](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/storage/runLifecycle.ts#L320-L345),
[inactive-run stop](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/runRegistry.ts#L585-L648).

The contract must retain these distinctions:

| Operation                  | Required meaning                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Stop waiting for a result  | Release that observer; leave execution alone.                                           |
| Explicitly stop work       | Ask the execution owner to stop, with the appropriate durable cancellation consequence. |
| Close a session or process | Release local execution; unfinished work can remain recoverable.                        |
| Recover after interruption | Reconstruct from recorded facts and the replay policy.                                  |

`Run` can then be an observation object. It needs no private execution fiber
or separate completion state. This part has since merged in
[PR #14395](https://github.com/LionSR/TeXRA/pull/14395); the remaining ownership
work should preserve it.

## 3. Define an input receipt before sharing its waiting code

pi records `queued`, `placed`, `done`, and `unanswered` submissions. A run
retains the IDs of inputs it incorporated. On success, each receives the same
answer reference; on failure, it receives an explicit unanswered result.
Thus the relation is many inputs to one answer. It does not certify that the
model addressed every instruction.
[Submission record](https://github.com/earendil-works/pi/blob/c3d8ce44d3231c7e46071d2d859f41ca7d39d21b/packages/durable/src/types.ts#L485-L530),
[result assignment](https://github.com/earendil-works/pi/blob/c3d8ce44d3231c7e46071d2d859f41ca7d39d21b/packages/durable/src/harness/live.ts#L268-L283).

DeepSeek's SDK subscribes before sending and waits for its own input ID to
appear. This is stronger than an unanchored idle wait. It nevertheless returns
the last assistant text before root idle, without a persistent relation from
that submission to that answer. Its separate server `session/wait` also
checks descendants and unchanged root activity; these two waits should not
be conflated.
[SDK run](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/api.ts#L203-L257),
[server wait](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L304-L320).

In TeXRA, `followup.consumed` has several uses. Text is consumed alongside its
incorporation into a model input, before an answer exists. Stale child notices
are consumed without delivery. Finalization consumes pending **controls**,
including model and compaction requests; it does **not** consume every unread
text message. The reviewed release PRD made a broader claim; its subsequent
revision listed above corrects it.
[Batch consumption](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/FollowUps.ts#L175-L271),
[controls-only filter](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/loop/rows.ts#L178-L190),
[finalization](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/storage/runLifecycle.ts#L248-L258).

A useful message receipt distinguishes acceptance, incorporation, and a
terminal result containing either an answer reference or a reason for ending
without one. A control receipt instead distinguishes application from
cancellation or rejection. Closing the local process does not, by itself,
make a recoverable input unanswered. The receipt's wait must observe committed
facts and safely cover the interval between reading and subscribing.

Two remaining retry decisions matter before adding a caller-supplied ID:

1. **A lost acknowledgement must remain recoverable after input closes.**
   `Inbox.admission` checks closure before duplicate recognition. A public
   retry must first recover the earlier accepted operation, while retaining
   the appropriate access checks.
2. **An ID reused with changed content needs a stated policy.** Current
   internal deduplication compares IDs only. pi deliberately returns the first
   submission even when repeated content differs. For TeXRA's public API,
   prefer returning the original receipt for the same normalized request and
   rejecting a conflicting request explicitly. Scope identity to the run and
   request kind, and compare the stored semantic request rather than object
   serialization order.

[TeXRA admission](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/followUp/Inbox.ts#L281-L331),
[pi duplicate handling](https://github.com/earendil-works/pi/blob/c3d8ce44d3231c7e46071d2d859f41ca7d39d21b/packages/durable/src/harness/submissions.ts#L198-L214).

Use the existing history and projections for these facts. Before promising
that no row-format change is needed, demonstrate an unambiguous input-to-turn
and turn-to-answer relation through batching, failure, and recovery. Existing
IDs prove input identity; they do not by themselves prove that relation.
`restsWith` currently waits for a waiting position after its batch disappears.
Replacing it with immediate consumption would weaken its meaning.
[Current wait](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/resumeRun.ts#L218-L249).

## 4. Authorize one concrete operation and preserve replay identity

DeepSeek copies and freezes tool arguments. Its decision type deliberately
excludes rewriting because the arguments have already been recorded and
displayed. Policy and approval are followed by guards that may still reject
the operation. An earlier approval cannot override those guards.
[Argument snapshot](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/pipeline.ts#L149-L163),
[decision contract](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/contracts.ts#L348-L361).

TeXRA's revised decision-chain proposal correctly puts rewriting before
permission. It should preserve two values: the input originally issued, and
the validated input actually authorized and executed. This distinction is
necessary because script recovery compares the recorded script input with
the original operation. Replacing that record with rewritten arguments could
make a faithful replay appear divergent.
[Replay comparison](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/loop/toolUseDispatch.ts#L830-L845).

The required order is:

```text
original operation
    → recorded hook outcomes and any rewrite
    → validate final operation
    → permission for that operation
    → durable execution intent
    → execute that same operation
```

Recovery reconstructs the effective input from committed outcomes instead of
running the hooks again. Path checks, command rendering, permission displays,
and execution must agree on that input. File-edit approval belongs after a
concrete edit has been prepared and before it is applied. Questions whose
purpose is to obtain user input are not permission checks.

This does not require a public hook framework without a consumer. Keep the
decision in the existing tool path, with one owner for policy interpretation
and the existing durable request/decision mechanism for human answers.
DeepSeek's in-memory approval continuation is a weaker recovery contract;
recorded approval events alone do not make that continuation durable.
[DeepSeek approval](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/interaction/user-approval/src/index.ts#L242-L330).

## 5. Preserve the transaction guarantees the peers do not replace

pi explicitly orders durable commit, adoption into in-memory state,
publication, and completion of waits. A failure after adoption cannot pretend
that committed history was rolled back. Deferred progress writes have a
different, weaker contract. TeXRA already has one transactional publisher;
the useful borrowing is this ordering invariant, not another storage
interface.
[pi adoption](https://github.com/earendil-works/pi/blob/c3d8ce44d3231c7e46071d2d859f41ca7d39d21b/packages/durable/src/session/session.ts#L890-L938),
[TeXRA publisher](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/SessionEvents.ts#L218-L263).

DeepSeek's measured minimal profile includes checkpoint policy: it waits for
persistence before model dispatch and top-level tool execution. Its 200 ms
batching interval is therefore not the whole durability guarantee. The
existing comparison already describes these checkpoints. Recovery distinguishes
a call known not to have started from one whose outcome is unknown; neither
constitutes permission to repeat an arbitrary external effect.
[Checkpoint policy](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-checkpoint-policy/src/index.ts#L29-L81),
[history repair](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/session/src/repair.ts#L116-L192).

DeepSeek's child completion requests a final flush, then separately notifies
the exact live parent object. A missing or replaced parent receives no notice;
a delivery failure is warned. A successful child flush followed by a crash
before parent enqueue therefore has no demonstrated recovery guarantee in
this path. This is an inference from the implementation, not a reproduced
failure or a claim that DeepSeek promised exactly-once delivery.
[Child notification](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/manager.ts#L1194-L1245).

TeXRA already couples child completion and delivery through its final
transaction, then releases the child's claim before waking its parent. Keep
that order. There is no reason to add a second pending-delivery system for
these same-database operations.
[Final transaction](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/storage/runLifecycle.ts#L230-L274),
[release before wake](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/childRunLoop.ts#L798-L812).

## 6. Choose consolidation within the existing owners

| Design                                          | Benefit                                                                                                                  | Cost                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| A. A new general session engine                 | A single interface can hide launch, recovery, receipts, permission, and storage.                                         | Replaces working Effect and history mechanisms; risks coupling unrelated lifetimes behind one large implementation. |
| B. Consolidate decisions within existing owners | History answers what happened; the runtime owns current execution; approval decides permission for a concrete operation. | Requires precise contracts between these owners, especially for completion and receipts.                            |

Prefer B. The dependency structure should express four existing
responsibilities, without creating four new service wrappers:

| Responsibility                 | Authority                                        | Duplication to remove                                                  |
| ------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------- |
| Recorded history and results   | SQLite, its publisher, and shared reducers       | Independently reconstructed completion states.                         |
| Local execution and release    | Session runtime and scoped activation            | SDK execution ownership and repeated claim management.                 |
| Input-to-answer correspondence | Committed input and turn facts                   | Queue-empty guesses, private wait predicates, and model-call counting. |
| Permission                     | One policy decision over the effective operation | Repeated policy interpretation inside individual tools.                |

`SessionHandle` currently contains substantial owners, not merely forwarding
methods. Replacing every member with an Effect tag would preserve most of the
complexity. Remove duplicate routes to the same dependency, and resolve
initialization cycles rather than hiding them in context. Judge each service
by the behavior it owns, not by the size of the containing record.
[SessionHandle](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/agent/runtime/SessionHandle.ts#L328-L357).

The public request protocol should also relate each command to its own
response type. A broad `Outcome` union makes callers handle impossible
results and encourages fallback presentation. A small type mapping can be
worth adding even when it does not reduce line count. This belongs with the
existing request and receipt work, not a second SDK interface.
[Current request signature](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/effect/sessions.ts#L250-L258).

## 7. Corrections to carry into the comparison

- **Credentials are already injectable.** Public `AgentPlatform.secrets` is
  provided to `Secrets.layer`. The convenience constructor's defaults do not
  erase that capability. HTTP injection is a separate issue: model traffic
  uses a bound transport, and embedded `Sessions.layer` does not replace the
  host's global dispatcher. The examples' transport prototype patch still
  indicates a missing supported injection point.
  [Platform contract](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/effect/sessions.ts#L61-L82),
  [composition](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/src/effect/processLayer.ts#L97-L139),
  [example patch](https://github.com/LionSR/TeXRA/blob/66d165b77de80d6ac102bc79a5aa3a84e781429e/packages/harness/example/_support.ts#L111-L134).
- **pi's inspected behavior is not all released 1.4.0 behavior.** Adoption,
  deferred persistence, and the event-view changes appear under `Unreleased`.
  [Changelog](https://github.com/earendil-works/pi/blob/c3d8ce44d3231c7e46071d2d859f41ca7d39d21b/packages/durable/CHANGELOG.md#L3-L21).
- **DeepSeek service contracts are typed despite string identifiers.**
  Context declaration merging and required injection declarations supply
  checks. The real composition burden is understanding active profiles,
  optional services, inheritance, and ordering. A static import graph alone
  does not describe that deployment.
  [Typed tools service](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/index.ts#L32-L35),
  [required dependencies](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/agent-loop/src/index.ts#L292).
- **Counts are measurements, not causal conclusions.** Exception-syntax
  density does not establish Effect's total benefit or performance; export
  counts need comparable scope; absence of two-way pairs does not exclude
  longer cycles. A claim that half the implementation repeats decisions needs
  a demonstrated deletion analysis, not just a size ratio.
- **Existing coverage and release acceptance are different.** TeXRA has
  focused coverage for failure before the final view and child-result
  recovery. That does not complete the proposed integrated release scenarios,
  but blanket descriptions of missing regression coverage overstate the gap.

## 8. Implementation order and acceptance

The release PRD now incorporates several of these principles. Preserve the
existing work on observation-only `Run`, one public result, approval decisions,
and dependency direction. Do not start another overlapping refactoring.

1. Specify receipt semantics, retry conflicts, termination consequences, and
   original versus effective tool input. Resolve any required row changes
   before freezing the storage format.
2. Complete execution ownership and the single termination decision. Preserve
   child delivery and activation exclusion. Define scope cleanup for work
   that never starts.
3. Implement the operation-specific permission decision in the existing tool
   path. Keep durable human decisions and recorded hook replay.
4. Expose meaningful receipts through the existing local and remote protocol.
   Delete private wait reconstructions only after their required behavior is
   supplied by those receipts.
5. Narrow dependencies and move directories after these responsibilities are
   stable. Measure the deleted decisions and access paths, then report lines.

Use existing suites to establish the following observations; this is an
acceptance list, not a request for a new test framework:

| Scenario                                     | Required observation                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Stop before a launch fiber starts            | Cleanup completes; explicit stop and shutdown retain their different durable meanings.           |
| Old activation ends while a new one starts   | No late write or cleanup can affect the new execution.                                           |
| Child completes while parent waits           | Child result and parent delivery commit together; wake follows claim release.                    |
| Input is incorporated, then execution fails  | Receipt never reports an answer that was not committed.                                          |
| Several inputs share a turn                  | Each receipt references the same committed answer, with no one-answer-per-input fiction.         |
| Send commits but its acknowledgement is lost | Retry after closure returns the earlier receipt; conflicting content fails explicitly.           |
| Observer is cancelled                        | Execution continues unless an explicit stop was requested.                                       |
| Rewrite commits, then the process crashes    | Recovery preserves original replay identity and executes only the effective approved operation.  |
| Durable commit succeeds, publication fails   | Committed facts remain authoritative; callers see the failure rather than a fictitious rollback. |

## Verified

The three pinned source trees, relevant existing tests, current proposals, and
overlapping issues and PRs were inspected. The conclusions above distinguish
observed source behavior from design requirements and untested crash
inferences. Neither peer's dependencies were installed and neither peer's
tests were run.

A focused TeXRA check run during this review passed the existing test for
failure before the final view in `AgentPackage.vitest.ts`. The selected
TeXRA-plugin crash-conformance suite failed to load because `shell-quote` was
missing, so its child-recovery case was not executed. This is not a report
that release recovery acceptance has passed. No runtime source was changed.
