# Session messaging: one inbox row for every run-to-run message

Status: proposed

Origin: the owner asked that live sessions in one project be able to message
each other the way terminal sessions do under tmux, and that subagent →
orchestrator reporting use the same pattern. A four-entry design tournament
ran against the code. This note takes the winner, **deletion-first** (81),
adds what the judges recommended from the runners-up, and corrects every
claim the judges found false. Each code claim below was re-verified on
2026-09-25.

## Summary

- **A message is a `followup.queued` row on the recipient run's own
  aggregate.** This row already carries user input, child reports, child
  progress and orchestrator follow-ups. We keep the row and the one
  admission path. The row's category label `origin: 'user' |
'subagent_result'` becomes a structured sender, `from`.
- **Sending is one verb, `executions send`.** Listing is the existing
  `/executions` view, and waiting is the existing `executions wait`.
  `delegate_agent` goes back to only spawning agents. `resumeAgent`, its
  wake-failure side channel and the `<orchestrator-followup>` framing are
  deleted.
- **The relation is decided by admission.** When admission (running inside
  the recipient's owner process) accepts a message, it stamps whether the
  sender is to the recipient in the supervision tree (parent, child,
  ancestor, descendant, sibling or peer). The sender never supplies it. It
  drives display and instruction promotion, and never who may talk.
- **No guards.** There is no hop limit and no mailbox cap (owner decision
  9). A run's messages are bounded by its turns, and a loop between agents
  is stopped by a person stopping the runs.
- **Runs talk as a graph.** Any run may message, and wake, any run in the
  project. The tree only says who supervises whom (see A graph over a
  tree).
- **This proposal only messages runs owned by the same process.** A message to
  a run owned by another process fails loudly, and a durable outbox for
  that case is sketched for a separate ruling.

What the user calls "sessions alive in one project" are **runs** inside one
`SessionHandle`. There is one handle per storage root
(`src/agent/runtime/SessionHandle.ts:14-19`), backed by one `texra.db`. This
design adds no session concept, transport, table, aggregate kind, row type,
subscribe surface or writer.

## Problem

The primitive already exists. It is incomplete in four places.

1. **Provenance is a category, not a sender.**
   - `FollowUpContentSchema.origin` is `z.enum(['user', 'subagent_result'])`
     (`src/shared/schemas/sessionEvent.ts:76`).
   - The queue manager silently fills in `origin: followUp.origin ?? 'user'`
     (`src/agent/followUp/ToolUseFollowUpQueueManager.ts:301`). The string
     overload of `submitFollowUp` (`src/agent/followUp/ToolUseFollowUp.ts:302`,
     `typeof followUp === 'string' ? { text } : …`) leads into that default.
   - Three bare-string producers are therefore recorded as user input:
     - `resumeAgent` (`src/tools/delegation/DelegationTools.ts:342`)
     - the agent-CLI resume (`src/tools/agentCliShared.ts:144`)
     - GitHub subscription notices (`src/tools/github/RunSubscriptionRegistry.ts:155`)
   - `userFollowUpInstruction` (`src/agent/followUp/followUpMessages.ts:45-54`)
     then promotes every `'user'` row to the run's instruction variable
     (`src/agent/runtime/FollowUps.ts:222`). For orchestrator follow-ups this
     is intended. For a CI notice it is a bug.
2. **Addressing only works along the parent edge.**
   - `resumeAgent` refuses any target that is not the caller's own child
     (`handle.isOwnedBy`, `DelegationTools.ts:333`).
   - `agentCliShared.ts:111` has the same guard.
   - There is no way for a run to message a sibling or peer.
3. **The send verb is hidden inside a launcher.** It is the `execution_id`
   field of `delegate_agent`, XOR-refined against `agent`
   (`DelegationTools.ts:223-230`, with dispatch at 252).
4. **A second channel reports one fact.** `deliverResumeWakeFailure`
   (`DelegationTools.ts:76-110`) forks a detached second delivery to tell the
   orchestrator that a wake failed, even though the tool result it is
   reading already says so.

**Correction to all four tournament entries.** All four claimed that
`executions wait` already breaks early when a reply arrives. It does not.

- `awaitStatusChange` observes `followUps.onSent`
  (`src/tools/ExecutionsTool.ts:113-136`).
- `onSent` fires only through `notifyFollowUpSent`, and that is called at a
  single site: an `active` route that returns `delivered_live` when the mode is
  not `live_notification` (`ToolUseFollowUp.ts:185-191`). The CLI's
  `sessionCommands.ts:155` also calls it, but for its own queued input.
- Child reports call `session.followUps.submit` directly
  (`src/agent/runtime/childRunLoop.ts:607`) and never fire it.

Today a waiting orchestrator is therefore **not** woken early by its child's
result. PR 1 fixes this (see Delivery semantics).

## The primitive

The schema moves to a new leaf, `src/shared/schemas/followUp.ts`, and is
re-exported through the `@shared/schemas` barrel, so nothing imports the leaf
directly. Moving it frees about 10 lines in `sessionEvent.ts`, which is at 807
of its 808-line budget.

```ts
/** Who put this input on the run. `relation` is stamped by admission from
 *  both runs' `run.start.parent` (and the recipient's `run.detach`), in the
 *  recipient owner's exclusive job — never taken from the sender. It is the
 *  relation as admitted; a later detach does not rewrite history. */
export const FollowUpSenderSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('run'),
    runId: RunIdSchema,
    relation: z.enum(['parent', 'child', 'peer']),
  }),
  /** Host-originated notices. Never an instruction. */
  z.strictObject({
    kind: z.literal('notification'),
    source: z.literal('github'),
  }),
]);

export const FollowUpContentSchema = z.object({
  text: z.string(),
  displayText: z.string().nullish(),
  mediaFiles: z.array(z.string()).nullish(),
  from: FollowUpSenderSchema, // replaces origin
});
```

**Producer input.** On `FollowUpQueueInput`
(`ToolUseFollowUpQueueManager.ts:30-45`), `from` becomes **required**, spelled
`{kind:'user'} | {kind:'run', runId} | {kind:'notification', source}`.
Admission turns `{kind:'run', runId}` into the
stored arm by adding `relation`. The `?? 'user'` default and the string
overload of `submitFollowUp` are deleted, so the compiler finds every producer
and none can omit its sender.

**Format.** `SESSION_EVENT_FORMAT` goes up by one from its current value (17 at the 2026-09-26 merge of `main`)
(`sessionEvent.ts:591`), and the fingerprint pinned in
`sessionEventFormat.vitest.ts` is updated. There is no legacy reader. Every
schema change in this proposal lands in that single bump.

**Consumers keep their signatures** because the relation is stored on the row:

- `userFollowUpInstruction` keeps `from.kind === 'user' || (from.kind === 'run'
&& from.relation === 'parent')`. Orchestrator follow-ups still feed the
  child's instruction, as they do today, and GitHub notices, peer messages and
  child reports never do. This fixes the notification bug and does not
  silently drop parent instructions, which is the flaw the judges found in
  ledger-mailbox and actor-society.
- `followUpDisplay` (`followUpMessages.ts:19-44`) changes its envelope test from
  `origin !== 'subagent_result'` to `from.kind === 'run' && from.relation ===
'child'`. Other senders show `displayText` or `text`.

## Addressing and the tmux-like surface

| tmux             | Model (tool)                                                                                                                                                                                                                                                              | Human                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `list-sessions`  | `executions` view `/executions`, which already lists every run in the root from the cold fold, with identity, parentage and status (`src/tools/ExecutionsTool.ts:359-383`). It gains a `relation to you` column and a `pending N` count read from `view.queuedFollowUps`. | The existing run list in all three hosts gains the same relation chip and unread badge. Both are fold data, not computed at render time. |
| `send-keys -t X` | **New** `executions {path:'/executions/<runId>', action:'send', message}`                                                                                                                                                                                                 | The composer on run X. It is already `followUp.send` (`src/shared/session/runtimeRequest.ts:35`), with `from:{kind:'user'}`.             |
| `wait-for`       | `executions wait` (existing). It now breaks on any live input to the caller.                                                                                                                                                                                              | n/a                                                                                                                                      |
| `capture-pane`   | `executions view /executions/<id>/conversation` (existing)                                                                                                                                                                                                                | Select the run.                                                                                                                          |

- **Address.** An address is a `RunId`, and the model may use a unique prefix
  of at least 6 characters. An ambiguous prefix is a tool error that lists the
  candidates. There is no nickname registry; the agent name is shown next to
  the id.
- **Scope.** The address space is one `SessionHandle`, so a run in another
  project cannot be addressed by construction.
- **Schema.** `SendActionSchema` goes in `src/tools/executions/toolInput.ts`
  (146 lines):

```ts
const SendActionSchema = z.strictObject({
  path: PathFieldSchema, // must be /executions/{id}
  action: z
    .literal('send')
    .describe(
      "Put a message on another run's input. It is read when that run finishes its current turn; a reply, if any, arrives as your own follow-up.",
    ),
  message: z.string().min(1),
});
```

- **Envelope.** The body is framed once as `<run-message from="<callerRunId>"
agent="<callerAgent>">…</run-message>`. This replaces `<orchestrator-followup>`
  (`formatFollowUpInstruction`, `src/tools/delegation/subagentResults.ts:253`;
  `stripOrchestratorFollowup`, `src/shared/subagentFollowup.ts:91`). The producer
  sets `displayText` once, as `Message from <agent>: <preview>`, and no renderer
  computes a sender label.
- **CLI.** The TUI gets `/ps` (a projection of the run listing) and `/send <id>
<text>` (the composer's `followUp.send` for another run in the same session).
  Both are thin, and they are staged last.
- **Future.** Shell-level `texra send` to another process needs the
  cross-process ruling described below.

## Delivery semantics

`executions send` goes through the unchanged `submitFollowUp` route
(`runs.getToolUseFollowUpTarget`, `runRegistry.ts:306-333`). The one new
authorization rule, in `src/tools/executions/send.ts`, is:

1. **Target check.** The target exists, has `category === 'toolUse'`, and is not
   the caller. Workflow runs refuse, as `resumeAgent` did.
2. **Revival right.** _Superseded by owner decision 8:_ every run sender
   uses the default mode, so any run may wake an idle run. This section
   first proposed that only the recipient's parent and the human could, with
   every other sender on `mode: 'live_notification'`.

| Recipient                                           | Route                                                                                                                                     | Result to the sender                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **RUNNING mid-turn** (flow attached)                | `active` → `live_owner`. The row is committed and offered to `RunInput`, and it is consumed at the next park (`loop/toolUse.ts:651-702`). | `sent` for every run sender. **No mid-turn injection:** this is typing into a busy pane.                                                 |
| **WAITING, parked**                                 | `active`, `delivered_live`. `followUps.wait` returns, and the recipient takes a turn now.                                                 | Same as above.                                                                                                                           |
| **Idle (persisted WAITING, no fiber), recoverable** | `queue`, `recoverable` with lease, then `startFollowUpWake`, for every sender.                                                            | `queued` (or `queued{wake:'failed'}`).                                                                                                   |
| **Dead or ended**                                   | `no_session` → `classifyRefusal`                                                                                                          | `failed{finished}` or `failed{unusable_checkpoint}`                                                                                      |
| **Owned by another process**                        | admission maps `DatabaseNotOwner` (`ToolUseFollowUpQueueManager.ts:146-150`)                                                              | `failed{owned_elsewhere}`: "live in another TeXRA window". Loud, and nothing is written.                                                 |
| **Detached child**                                  | top level in the view, so `runRelation` stamps its former orchestrator `peer`                                                             | Its own turn reports still go nowhere (`warnDetachedChildDelivery`). Any run, its former orchestrator included, may message and wake it. |
| **Headless (`stopAfterCycle`)**                     | consumed only while it is running                                                                                                         | `queued` while it is running. After it ends: `failed{finished}`.                                                                         |

**Durability.**

- The row is committed before any result is acknowledged.
- Pending rows are seeded into `RunInput` on resume.
- `followup.consumed` commits in the same `appendBatch` as the message it
  becomes (`FollowUps.ts:204-217`).

A crash therefore re-delivers the row and never delivers it twice. The sender's
tool call is itself in the ledger, so a replayed turn does not re-run a
committed `tool.result`.

**Waking a waiting sender (the corrected claim).** `executions wait` stops
listening for an in-process callback. It watches committed state instead: the
caller's pending follow-ups in the session view. See
[Effect-native shape](#effect-native-shape). Any row admitted to the waiting
run ends the wait, whoever sent it and in whatever mode. That includes a
child's report, a peer's reply, a human's message and a `live_notification`
send.

**Cross-process.** This proposal does not deliver across processes, and the
refusal is loud. Desktop opens one session per project in one process, and a
VS Code window hosts all its conversations in one process, so the owner's
same-project case works fully.

The only shape compatible with D1
(`archived/architecture/2026-08-23-single-owner-sessions.md`) is ledger-mailbox's
outbox:

- A `message.posted {messageId, to, content}` row goes on an aggregate the
  sender owns.
- The recipient's owner is woken by the existing `PRAGMA data_version` poll
  (`Database.ts:395-430`). That poll runs at 250 ms; it backs off only after
  read failures.
- The owner re-admits the row into its own `followup.queued` under
  `deliveryId = messageId`, and admission's replay check makes that
  idempotent.
- Delivered, read and bounced states are derived from the fold, with no
  receipt rows.
- A pending age greater than 60 s is surfaced as "undelivered", so a stalled
  relay is visible.

That relay needs a D1 amendment and is not built here. It is an open question.

## Subagent reporting on the same primitive

After PR 1, `childRunLoop.deliverTurn` is simply the automatic send that a
child makes to its supervisor when a turn settles:

- **Child → parent report.**
  - Today: `{text: envelope, origin: 'subagent_result', deliveryId}` at
    `childRunLoop.ts:586-590`.
  - Becomes: `{text: envelope, from: {kind:'run', runId}, deliveryId}`.
  - The idempotent `turnDeliveryId`, the #8093 deferred live offer,
    `commitChildTurn` ordering and `submitPendingDelivery` remain. They are the
    durability of this primitive, not a second mechanism.
- **Child → parent progress.** The progress path (`childRunLoop.ts:918-946`) is
  the same row with the same sender.
- **Parent → child follow-up.** This becomes `executions send`. Admission stamps
  `relation: 'parent'`, so the follow-up still feeds the child's instruction and
  may revive the child.
- **Peer ↔ peer.** Also `executions send`.
- **Human → any run.** The composer.
- **Kept on purpose: in-band delegation for headless parents**
  (`subagentRun.ts:129-164`). A `stopAfterCycle` parent never parks, so it can
  only take a child's text as a synchronous tool return. This is the call form
  of the same relationship, not a second message channel.

**Deleted:**

- `resumeAgent` (`DelegationTools.ts:299-397`). About 45 lines move to
  `executions/send.ts`, and the parent-edge refusals at 321-338 are dropped.
- `deliverResumeWakeFailure` (`DelegationTools.ts:76-110`) and its
  `Effect.forkDetach`.
- The `execution_id` field, its XOR `.refine`, the resume dispatch branch, and
  the resume half of the tool description (`DelegationTools.ts:4, 208, 223-230,
251-262, 410-423`).
- `formatFollowUpInstruction` and `stripOrchestratorFollowup`, together with the
  `<orchestrator-followup>` branch in `src/ui/transcript/toolRowSections.ts`.
- The `origin` enum, the `?? 'user'` default, and the string overload of
  `submitFollowUp`.
- `onSent`, `notifySent` and `notifyFollowUpSent` with every call site (see
  Effect-native shape).

## Society scale

**No loop guard, no mailbox cap** (owner decision 9). An earlier draft
carried a durable hop counter (refuse a run's message past 32 hops since a
person spoke) and a per-sender cap (4 unread messages per recipient). The
owner ruled both too complicated for what they buy: each was a fold, a
refusal reason and a worded failure, and neither has met a misbehaving
society yet. A run's sends are bounded by its own turns and tool-call
limits; a loop between agents runs until a person stops the runs, the way
two shell scripts writing to each other's pipes run until someone kills
them. If a real society misbehaves, the guard comes back as its own
proposal, sized to what was observed.

**Cost.**

- Any run may wake an idle run, so a message can start a turn that costs
  money. Nothing bounds that spend except the user stopping runs.
- Waking a parked peer is billed to that peer's own pricing.
- Self-send is refused.

**Broadcast.** Broadcast is not a primitive in this design. The model issues
one `send` per recipient, and the per-turn tool-call limits bound how many.
Tree-derived multicast addresses (`@children`, `@siblings`, from
actor-society) are zero-state and could be added later as address sugar that
resolves in `send.ts`. That waits until a workflow needs it (open question).

**Supervision.** The supervision tree is unchanged:

- `run.start.parent` defines the tree.
- `detachSubagentsOnStop` handles stop cascades.
- `childRunBudget` limits concurrency.
- A child's terminal `<subagent-error>` report is the exit signal.

No restart strategies are added.

**Throughput.** Every message is one admission job on the session's one
publisher: one SQLite transaction per message. That is fine for hundreds of
runs, because model latency dominates.

The known cost is that admission's replay check reads the recipient's whole
aggregate (`port.rows`, `ToolUseFollowUpQueueManager.ts:571`). A long-lived hub
run that receives many messages pays O(rows) per admission. This cost exists
today; a society of agents makes it larger. Index it only when profiling shows
a need.

## Invariants honored

- **One publisher.** Every row is written by the `SessionEvents` `exclusive`
  admission job, and the relation stamp runs inside that job. There is no
  second append path.
- **Run ledger single writer.** Consumption stays in `FollowUps.consume`'s one
  `appendBatch`. `toolUse.ts` (796 of 796 lines) is not touched.
- **No new subscribe surface, and one fewer.** `onSent` is deleted. The wait
  reads the session view it already subscribes to. No `bus.emit` is added.
- **Zod as the single source of truth.** `from` is a discriminated union, the
  types are inferred from it, and there is one format bump with no legacy
  reader.
- **No silent degradation.** The `?? 'user'` default is deleted. Every refusal
  (`not_resumable`, `owned_elsewhere`) is a worded
  failure returned to the tool.
- **Ratchets.** No baseline is widened.
  - `ExecutionsTool.ts` (958 of 958 lines) pays for its dispatch arm by moving
    `listRuns` (359-383) to `src/tools/executions/`.
  - `sessionEvent.ts` pays for its change by moving the schema to a new leaf.
  - No new host deep import is added: the CLI `/send` goes through the existing
    `followUp.send` request.
- **Exports need a consumer.** Every new export (`FollowUpSenderSchema`, the
  send handler) has a consumer in the same PR.
- **Tests.** The existing `resumeAgent` suite is retargeted to `executions send`
  and gains two cases:
  1. A peer send to a parked run is consumed with `relation: 'peer'`.
  2. A peer send to a persisted run returns `not_resumable` and writes no row.

  PR 1 adds one regression test on `userFollowUpInstruction` for the
  notification arm.

- **Approvals.** A message carries no approval scope. Every tool the recipient
  calls is governed by its own policy, and `approvalPolicyAuthorityRatchet` is
  untouched.

## Effect-native shape

The rule: every step reads or writes committed state through services the
Effect runtime already provides. There are no callback registries and no
hand-rolled coordination.

**The wait watches the view, not an occurrence.** Today `executions wait`
bridges a callback into Effect:

- `Effect.acquireRelease` registers `followUps.onSent`, and the callback
  calls `Deferred.doneUnsafe` (`src/tools/ExecutionsTool.ts:113-136`).
- `onSent` is a `Set` of observers on the `ToolUseFollowUpQueue` class
  (`ToolUseFollowUpQueueManager.ts:179, 204-215`).
- Producers must remember to call `notifyFollowUpSent`. Child delivery never
  does, which is the bug.

The session already publishes its folded view as a `SubscriptionRef`, and
the wait already races `session.viewChanges` for status. The view carries
each run's untaken input as `view.queuedFollowUps`
(`src/shared/session/sessionView.ts:322`, projected by `projectFollowUps` in
`sessionFold.ts`). The follow-up leg of the race becomes a second condition
on the same stream: the caller's `queuedFollowUps` entry holds a
`followUpId` it did not hold when the wait started.

- **Why it is correct.** The caller is inside its own tool call, so its
  pending rows are not consumed until its loop parks after the tool returns.
  The rows stay visible for the whole wait. Comparing id sets, not counts, is
  robust to `SubscriptionRef` coalescing several changes into one emission.
- **What it fixes.** Every sender and every admission mode wakes the wait,
  because every one of them commits a `followup.queued` row. No producer has
  to remember a notify call. The future cross-process outbox needs no wake
  code either: its re-admitted row lands in the same view.
- **What it deletes.**
  - `onSent`, `notifySent` and `sentObservers` on the queue.
  - `notifyFollowUpSent` (`ToolUseFollowUp.ts:107`) and its conditional call
    at `:190`.
  - The `acquireRelease` and `Deferred` bridge in `awaitStatusChange`.
  - The CLI calls at `chatSessionController.ts:912, 1298` and
    `sessionCommands.ts:155`, and the observer in `progressTestUtils.ts`.
- **One behavior to decide.** `/compact` calls `notifyFollowUpSent` today, so
  it breaks a pending wait. A compaction is a runtime request, not a
  `followup.queued` row, so after this change it no longer breaks the wait.
  If that behavior is wanted, PR 1 extends the predicate to the caller's
  compaction request as the view records it. Verify that record before
  adding the leg.

**Serialization is the publisher's.** The relation stamp runs inside the `SessionEvents` `exclusive` job. That job's queue is
the lock, so there is no `Semaphore`, no `withPerKeyLane` and no read-then-write
race.

**Outcomes are values, and failures are typed.** `sent | queued |
failed{reason}` is a result returned to the model, not an error, and
`FollowUpFailureReason` keeps its existing arms. Storage failures stay tagged errors: `DatabaseNotOwner`
maps to `owned_elsewhere` at the one existing site. No error channel is
spelled `unknown` (`unknownErrorChannelRatchet`).

**The send is a plain tool program.** `send.ts` is an `Effect.fn` tool body
that takes `ToolCall` and the session from context, the way
`ExecutionsTool.ts` does.

- It has no `Effect.run*` call and no `new AbortController(`, so the
  `effect-migration` ratchet is untouched.
- Interrupting the caller's tool call before the admission job commits
  sends nothing.
- Once the row commits, it stands. The commit is the acknowledgement.

**The later outbox is a scoped fiber.** If cross-process delivery is ruled
in, the relay is one fiber forked in the session layer's scope
(`Effect.forkScoped`). It reads the existing tail stream, filters
`message.posted` rows addressed to runs this process owns, and re-admits them
through `exclusive`. It does not use `setInterval` or add a `PubSub`.

**Rejected Effect facilities:**

- A `PubSub` or `Mailbox` per run. It would be a second subscribe surface and
  would lose durability: an in-memory message dies with its process, while a
  row does not.
- `@effect/cluster` entities or an actor runtime. That is sharding and
  routing machinery for one process, with addressing that duplicates the
  session view.

## Plugin boundary: core primitive, plugin-owned verb

The [plugin architecture](../../implemented/architecture/2026-09-24-plugin-architecture.md)
decides where each part lives. Its "What is deliberately core" list names the
run ledger and the run loop, and it gives plugins no durable state, event
channel or hooks. So:

- **Core, not switchable.** The `followup.queued` row with `from`,
  relation stamping inside admission, and the
  wait reading committed pending follow-ups. Subagent reports travel on this row, so a
  plugin switch must never be able to cut a child off from its orchestrator.
  The `notification` sender fix is core for the same reason.
- **Already plugin-owned.** `executions` and `delegate_agent` belong to the
  `memory-workflow` plugin (`src/tools/registry.ts:133-141`). As proposed,
  `executions send` lands in that plugin, beside the delegation tools it
  replaces. No manifest change is needed.

**Considered: a separate `agent-messaging` plugin.** Peer sends would move to
their own tool (`send_message`) under a new plugin id.

- **For:**
  - The plugin switch is the kill switch that open question 2 asks about.
    It comes with a dashboard card in all three hosts and needs no new
    setting.
  - An agent could message peers only if its YAML `tools:` names the tool, so
    peer messaging becomes opt-in per agent.
  - The run's pinned composition records whether it could send.
- **Against:**
  - Parent → child follow-ups must work whenever delegation works, so they
    would stay on `executions send`. That leaves two send verbs split by
    relation, which is the kind of duplication this proposal removes.
  - It adds one more tool to the model's surface.

**Recommendation:** ship `executions send` inside `memory-workflow` as
proposed. Split out `agent-messaging` only if the owner wants a switch for
peer messaging specifically. In that case the split is a follow-up to PR 2:
it moves the peer arm of `send.ts` behind the new plugin and leaves the
parent arm on `executions`.

## Alternatives considered

- **ledger-mailbox (78).** The same in-process core as this design, plus a
  `message` tool, an `intent`/`replyTo` pair, a `wake:'never'` admission mode,
  a mail fold and a courier fiber for cross-process delivery. It lost on
  simplicity. It also filtered instructions to `from.kind === 'user'`, which
  would silently stop parent follow-ups from reaching the child's instruction.
  Taken from it: the `notification` sender arm and the outbox sketch.
- **actor-society (74.5).** Derived nicknames, broadcast groups, `expectsReply`,
  mailbox caps and a policy gate inside admission. It lost because of its
  surface area: unstable nicknames, a default scope that contradicted the ask,
  and a claim to delete `RunHandle.isOwnedBy`, which is still used by
  `ExecutionsTool.ts:483`, `runRoster.ts:208` and `runStopping.ts:303`. Taken
  from it: relation stamped on the recipient side.
- **unix-crossprocess (66).** Every message goes through `mail.sent` and a
  courier, including in-process child reports. It lost for three reasons:
  - It puts an asynchronous courier on every subagent result's critical path.
  - It writes durable progress rows, which CLAUDE.md forbids.
  - It deletes the #8093 and #9531 safeguards on an unverified finalize-batch
    assumption, when finalization runs through the shared `finalizeRun`.

  Taken from it: the "undelivered" surfacing of pending age for the future relay.

## Staged PR plan

Each PR ships on its own and deletes something.

1. **Sender, not category.** Covers the schema, the format bump and the wait fix.
   - Move `FollowUpContentSchema` to `schemas/followUp.ts` with `from`.
   - Stamp `relation` in `admit`.
   - Make `from` required on `FollowUpQueueInput`.
   - Name the sender at every producer:
     - composer, host actions and inquiry: `user`
     - child delivery and progress: `run`
     - `resumeAgent` and agent-CLI resume: `run`
     - GitHub: `notification`
   - Switch `followUpDisplay` and `userFollowUpInstruction` to the new fields.
   - Make `executions wait` end when the caller's `view.queuedFollowUps` gains
     a new id.
   - **Deletes:** the `origin` enum, the `?? 'user'` default, the string
     overload of `submitFollowUp`, and `onSent`, `notifySent` and
     `notifyFollowUpSent` with their four call sites.
   - **Fixes:** GitHub notices no longer become the instruction, and
     `executions wait` now breaks on a child report.
2. **`executions send`.**
   - Add `SendActionSchema` and `send.ts`, with the target check, and revival rule.
   - Add the `<run-message>` envelope.
   - Move `listRuns` out to pay for the `ExecutionsTool.ts` lines.
   - Update `creator.yaml`,
     `resources/docs/agent-creation/{execution_and_testing,tool_catalog}.md`,
     and the descriptions at `codex.ts:508` and `claudeAgent.ts:596`.
   - **Deletes:** `resumeAgent`, `deliverResumeWakeFailure`, the `execution_id`
     field, its refine and its branch, `formatFollowUpInstruction`,
     `stripOrchestratorFollowup` and its row-section branch.
   - Run `check:dead-code-ratchet`.
3. **Surfaces.**
   - Add the relation column and pending count to `/executions` and to the host
     run lists (fold data).
   - Add the "from" chip through `displayText`.
   - Add the CLI TUI `/ps` and `/send`.
   - **Deletes:** the render-time envelope sniffing that `followUpDisplay` now
     owns, wherever a renderer still does it.
4. **Agent-CLI live follow-up through `send`.** Gated on measurement.
   - Route the live branch of `queueAgentCliFollowUp` and `requireCallerOwnership`
     (`agentCliShared.ts:105-165`) through `send.ts`.
   - Keep `thread_id` / `session_id` only for relaunching from disk.
   - Ship only if the net line count is negative. Otherwise record it in
     `refuted-candidates`.

## A graph over a tree

The owner's principle: agents are free to talk to each other. Communication
is a graph over every run in the project; the hierarchy is a tree over the
same runs, and it means supervision only: who launched whom, who stops
whom (`detachSubagentsOnStop`), whose concurrency budget a run draws on
(`childRunBudget`), and to whom a run's automatic report goes. Nothing in
the tree decides who may message whom.

- **Relation is read, never granted.** `runRelation`
  (`src/shared/session/runRelation.ts`) walks both runs' lineage in the view
  and answers what one run is to the other: parent, child, ancestor,
  descendant, sibling or peer. The same function stamps a message's sender
  and marks the `/executions` listing and the CLI's `/ps`. A deeper
  hierarchy (teams of teams) needs no new code: a great-grandparent is an
  `ancestor`.
- **What relation still decides.** A parent's message feeds the run's
  instruction, because a parent's follow-up is the delegation continuing;
  every other message informs the run, and the run decides what to do. A
  child's report is summarized for display.
- **Nothing bounds freedom but the person.** No relation, orchestrator
  included, has a hop limit or a mailbox cap (decision 9); the user stops
  runs that talk too much.
- **Long term.** Supervision can grow as a tree (orchestrators of
  orchestrators, standing teams) without touching messaging, and messaging
  can grow (group addresses such as `@siblings`, the cross-process relay)
  without touching supervision. The two structures meet only in the
  relation stamp.

## Owner decisions (2026-09-26)

The owner took the recommended answer to each open question and asked for
the whole plan to be built.

1. **Cross-process relay: deferred, not dropped.** Build in-process first;
   the sender-owned outbox follows as its own ruling on D1 once
   `executions send` has shipped. It is additive: a re-admitted row lands in
   the same admission and the same view, so nothing here changes for it.
2. **No hop limit** (decision 9), no kill switch and no `agent-messaging` plugin until a
   misbehaving society is observed.
3. **A child's report ends `executions wait`.** That is what the wait is for.
4. **Messages land at the turn boundary.** No mid-turn steering.
5. **The format bump ships with a changelog note** (format 19 on the branch, one above `main`'s 18).
6. **No multicast addresses** until a workflow needs them.
7. **`/compact` no longer ends a wait.** A compaction is a request, not a
   follow-up row, and it has no reason to wake a waiting run.
8. **Agents talk as a graph, not a tree** (asked for after the first
   build). Any run may message and wake any run in the project. See A graph
   over a tree.
9. **No hop limit and no mailbox cap** (PR review, 2026-09-26). The branch
   had built both (32 hops for every relation, reset when a person speaks;
   4 unread messages per sender at one recipient). The owner ruled them too
   complicated. They were deleted with the `hop` field, the `inboundHop`
   fold and the `hop_limit`/`mailbox_full` refusals; a loop between agents
   is stopped by a person.

## Implemented on the branch

`claude/multi-agent-session-messaging-0oupy3` builds PRs 1 to 4 as one
change. What it does, and where it differs from the plan above:

- **The sender is admission's.** A producer names only who it is
  (`FollowUpSenderInput`: the user, a notification, or a run by id). Inside
  the admission job, `stampFollowUp` (`src/agent/followUp/followUpSender.ts`)
  derives the relation from both runs' `parentId` in the session view.
- **No guards** (decision 9). Admission refuses only what it refused before
  (`owned_elsewhere`); a finished or persisted run keeps its old failures.
- **The wait reads the view.** `executions wait` ends when the caller's
  `view.queuedFollowUps` gains an id. `onSent`, `notifySent`,
  `notifyFollowUpSent` and their four call sites are deleted. A regression
  test in `ExecutionsToolWorkspaceFiles.vitest.ts` times out without the
  change and passes with it.
- **`executions send`** (`src/tools/executions/send.ts`) replaces
  `delegate_agent`'s `execution_id`. `resumeAgent`,
  `deliverResumeWakeFailure`, `formatFollowUpInstruction` and
  `stripOrchestratorFollowup` are deleted. A call with no calling run speaks
  as the user. Any sender may wake an idle run.
- **The listing** moved to `src/tools/executions/runListing.ts` and marks
  each run with what it is to the caller (`(your orchestrator)`,
  `(your sibling)`, `(your upstream orchestrator)`, …) from the one
  `runRelation` reading, with an `unread=N` count from the live view.
- **CLI:** `/ps` lists the session's runs with the same marks relative to the
  focused run, and `/send <id> <text>` sends through the composer's
  `followUp.send` request. Both live in `sessionContributions` in
  `sessionCommands.ts`, beside `/compact` and `/exit`, which moved there to
  keep `registerBuiltins.tsx` within its budget.
- **PR 5 was not built.** The agent-CLI follow-up (`codex`, `claude_code`)
  keeps its `thread_id`/`session_id` path and now names its sender through
  `senderOf`. Routing it through `send.ts` would not have been a net
  deletion.
- **Run lists in VS Code and desktop:** the shared `run-tab` row shows
  "N unread messages" from `view.queuedFollowUps`, passed down by
  `run-tabs`. No relation chip: the run tree already shows parentage, so the
  chip would only repeat it for a human reader.

## Still open

- The cross-process relay (decision 1).
