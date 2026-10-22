# Session messaging: one inbox row for every run-to-run message

Status: implemented

The owner asked that live runs in one project be able to message each other the
way terminal sessions do under tmux, and that subagent → orchestrator reporting
use the same pattern. This note records the design as built and the owner's
decisions of 2026-09-26. Paths are under `packages/harness/src/`.

## Summary

- **A message is a `followup.queued` row on the recipient run's own aggregate.**
  The same row carries user input, child reports, orchestrator follow-ups, peer
  messages and host notices, through one admission path. Its sender is `from`
  (`shared/schemas/followUp.ts`).
- **Sending is one verb, `executions send`** (`tools/executions/send.ts`).
  Listing is the `/executions` view, and waiting is `executions wait`.
- **The relation is decided by admission.** Inside the recipient's admission job
  (`agent/followUp/Inbox.ts`), `runRelation` (`shared/session/runRelation.ts`)
  stamps what the sender is to the recipient: parent, child, ancestor,
  descendant, sibling or peer. The sender never supplies it. It drives display
  and instruction promotion, never who may talk.
- **No guards.** There is no hop limit and no mailbox cap. A loop between agents
  is stopped by a person stopping the runs.
- **Runs talk as a graph over a tree.** Any run may message any run in the
  project. The tree (`run.start.parent`) says only who supervises whom: who
  launched whom, who stops whom, whose concurrency budget a run draws on, and
  where a run's automatic report goes.
- **Same process only.** A message to a run another process holds fails loudly
  (`owned_elsewhere`) and writes nothing.

What a user calls "sessions alive in one project" are **runs** inside one
session: one `SessionHandle` per storage root, backed by one `texra.db`.
Messaging adds no session concept, transport, table, aggregate kind, subscribe
surface or writer.

## The row

```ts
// shared/schemas/followUp.ts (abridged)
const FollowUpSenderSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('run'),
    runId: RunIdSchema,
    relation: RunRelationSchema, // stamped by admission
  }),
  z.strictObject({
    kind: z.literal('notification'),
    source: z.literal('github'),
  }),
]);
```

A producer names only who it is (`FollowUpSenderInput`: the user, a
notification, or a run by id; `senderOf` in `agent/followUp/followUpSender.ts`).
There is no default sender, so the compiler finds every producer.

- **Instruction.** A user's text and a parent's message become the run's
  instruction (`isInstruction`, `agent/followUp/followUpMessages.ts`). A child's
  report, a peer's message and a host notice inform the run and never become its
  instruction.
- **Display.** The producer sets `displayText` once
  (`Message from <agent>: <preview>`); a child's delivery envelope is summarized
  by `followUpDisplay`. No renderer computes a sender label.

## Sending

`executions send` (`{ path: '/executions/<runId>', action: 'send', message }`)
frames the body once as
`<run-message from="<callerRunId>" agent="<label>">… </run-message>` and submits
it through the one follow-up route. A call with no calling run speaks as the
user. It refuses:

- a message to itself;
- an unknown run, or one that takes no messages (only a conversation does);
- a one-shot run (headless, or an in-band child), which has no next turn
  boundary to read a message at.

| Recipient                    | What happens                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Running mid-turn             | The row commits and is consumed at the next park. No mid-turn injection: this is typing into a busy pane                              |
| Parked, waiting              | The row commits and the recipient takes a turn now                                                                                    |
| No live loop here, resumable | Only the user's own message continues it; a run's message is refused (`not_resumable`), so a run never restarts work the user stopped |
| Dead or ended                | Refused with its worded reason                                                                                                        |
| Held by another process      | `owned_elsewhere`: "This run is live in another process." Nothing is written                                                          |
| Detached child               | Top level in the view, so its former orchestrator is a `peer`; any run may message it                                                 |

The row is committed before any result is acknowledged; pending rows are seeded
into the run's input on resume; `followup.consumed` commits in the same batch as
the message it becomes. A crash therefore re-delivers the row and never delivers
it twice.

The human surfaces send through the `followUp.send` request: the composer on a
run, and `texra tasks send <id> <text>` in the CLI.

## Waiting

`executions wait` watches committed state, not a callback: the wait ends when
the caller's entry in the session view's `queuedFollowUps` gains a `followUpId`
it did not hold when the wait started (`tools/ExecutionsTool.ts`). The caller is
inside its own tool call, so its pending rows stay unconsumed for the whole
wait; comparing id sets, not counts, survives the `SubscriptionRef` coalescing
several changes. Any row admitted to the waiting run ends the wait, whoever sent
it: a child's report, a peer's reply, a human's message or a notice. A
compaction is a request, not a follow-up row, and does not end a wait.

## Subagent reporting on the same row

- **Child → parent report.** When a child's turn settles, the child loop
  (`agent/runtime/childRunLoop.ts`) submits its envelope as a `followup.queued`
  row with `from: { kind: 'run', runId }`. Its idempotent delivery id and its
  settlement in the turn's batch are the durability of this one primitive, not a
  second mechanism.
- **Parent → child.** `executions send`; admission stamps `relation: 'parent'`,
  so the message still feeds the child's instruction.
- **Peer ↔ peer.** `executions send`.
- **Human → any run.** The composer.

The `/executions` listing (`tools/executions/executionListing.ts`) marks each
run with what it is to the caller, from the same `runRelation` reading, and an
`unread=N` count from the live view.

## Plugin boundary

The `followup.queued` row with `from`, relation stamping inside admission, and
the wait reading committed follow-ups are core and not switchable: subagent
reports travel on this row, so a plugin switch must never cut a child off from
its orchestrator. `executions` is a harness built-in.

## Owner decisions (2026-09-26)

1. **Cross-process relay: deferred, not dropped.** Messaging is in-process. A
   sender-owned outbox that the recipient's owner re-admits would be additive (a
   re-admitted row lands in the same admission and the same view) and needs its
   own ruling against single ownership.
2. **No kill switch and no `agent-messaging` plugin** until a misbehaving
   society is observed.
3. **A child's report ends `executions wait`.** That is what the wait is for.
4. **Messages land at the turn boundary.** No mid-turn steering by another run.
5. **No multicast addresses** (`@children`, `@siblings`) until a workflow needs
   them.
6. **`/compact` does not end a wait.**
7. **Agents talk as a graph, not a tree.** Any run may message any run in the
   project.
8. **No hop limit and no mailbox cap.** Both were built and deleted as too
   complicated for what they buy; a loop between agents is stopped by a person.

## Considered and rejected

- A `PubSub` or `Mailbox` per run: a second subscribe surface that loses
  durability, since an in-memory message dies with its process.
- `@effect/cluster` entities or an actor runtime: sharding and routing machinery
  for one process, with addressing that duplicates the session view.
- A courier on every message, in-process child reports included: it puts an
  asynchronous hop on every subagent result's critical path and writes durable
  progress rows.
- A separate `send_message` tool for peers: two send verbs split by relation.
</content>
