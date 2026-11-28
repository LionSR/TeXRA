# How a report reaches the receiving model

Date: 2026-11-27
Status: proposed (the presentation half is built in the PR that adds this
note; delivery to the model is unchanged and waits on the decision below)

Origin: the owner's report that a child agent's "completed" report appears in
its parent's conversation as a user message, and the request that reports
arrive "via some general tool that agents and subagents can equally dial each
other".

## What exists

Sending is already one mechanism. `executions send`
(`packages/harness/src/tools/executions/send.ts`) lets any run message any
run, and a child's end report is the same `followup.queued` row
(`packages/harness/src/shared/schemas/followUp.ts`), queued by the child's
`run.end` transaction on each run it worked for (`replyDelivery`,
`packages/harness/src/agent/storage/runLifecycle.ts`). Every row carries its
sender (`from`: `user`, `run`, `notification`, `self`).

Receiving has two paths:

1. **A call the recipient has open.** An awaited `agent` call and
   `executions wait` take the child's end as their tool result
   (the `answered` disposition of `FollowUpDispositionSchema`). The model made
   the call, so the result is an ordinary tool result.
2. **The recipient's input queue.** Everything else is read at the next turn
   boundary by `packages/harness/src/agent/runtime/FollowUps.ts`, which merges
   the batch, whatever each item's `from`, into one `role: 'user'` message. A
   delivery is rendered as an XML envelope (`formatDelivery`,
   `packages/harness/src/agent/runtime/deliveryEnvelope.ts`); a message is its
   text.

The transcript logged that batch with one call that kept no sender, so each
host drew a child's report as the person's own bubble. That part is fixed:
the log payload carries `from`, the transcript row its `sender`, and the
progress view and the terminal draw a received message as a line from its
sender. This note is about path 2 as the model sees it.

## The problem with path 2

- **Role.** The model reads a child's report, a peer's message, a CI notice
  and the person's instruction in the same role. The envelope and the prompt
  rules are what tell it a report is a claim and a notice is not an
  instruction. That is a convention the model must keep, not a property of
  the request.
- **Two shapes for one event.** A child's end is a tool result when awaited
  and a user-turn envelope when not. Anything that reads "what did the child
  answer" (the transcript, `executions view`, a resume) handles both.
- **It is not a dial.** The sender used a tool; the recipient did not. "Agents
  dial each other" is half true.

## Provider constraints any design must keep

- A tool result answers a call the model made in the preceding assistant
  message, by id. Anthropic and the OpenAI Responses and Chat protocols all
  reject a result with no matching call, and a call with no result.
- An assistant message the harness writes is not the model's. With extended
  thinking (Anthropic) or reasoning items (OpenAI Responses, including the
  ChatGPT subscription route), an assistant turn that contains a tool call is
  expected to carry the thinking block or reasoning item that produced it:
  Anthropic requires the signed thinking block before a tool call when
  thinking is on, and Responses chains reasoning items to the calls they led
  to. A harness-authored call has neither. Providers accept an assistant turn
  with no thinking only when it follows a user turn or thinking is off, so a
  fabricated call is at best legal by accident of position, and it breaks
  prompt-cache and encrypted-reasoning continuity on the routes that chain.
- Chat protocols reject consecutive user messages, which is why a batch is one
  message today.

## Three designs

### A. Today's envelope, kept, with the sender made structural

Keep the user-turn delivery. Make each item its own content part with a fixed
header the harness writes (`from`, run id, label), so the sender is stated the
same way for every kind, and say in the system text what each sender means.

- For: no protocol risk, works on every provider and route, no stored-format
  change (the row already has `from`).
- Against: still the user role; still two shapes for a child's end.

### B. Delivery only as the result of a call the recipient has open

Reports arrive only where the recipient asked: the awaited `agent` call, or
`executions wait`. An unawaited child's end queues as today but is not put in
the user turn; the run is told, in a one-line harness notice, that reports are
waiting, and reads them with `executions wait` (or `executions view`), whose
result is the report.

- For: one shape for a child's end (a tool result, always); the recipient
  dials as the sender does; no fabricated turns; the notice is short and
  honest about its role.
- Against: one more model step per unsolicited report (the notice, then the
  call); a model that ignores the notice never reads the report, so the
  notice must repeat at each turn boundary while reports wait; the notice
  itself still rides the user turn. A run with no later turn cannot call
  anything, which is already true of any follow-up.

### C. A harness-authored `executions` call and result pair

At the turn boundary the harness appends an assistant message containing an
`executions wait` call it wrote, and the tool result carrying the report.

- For: the report is in the tool role with no extra model step.
- Against: the constraints above. It needs a per-provider rule for thinking
  and reasoning continuity, cannot be made correct on routes that chain
  reasoning items, puts words in the model's mouth that the transcript and
  the run history would have to mark as not the model's, and adds a second
  writer of assistant rows beside `ModelInvoker`. A person's message arriving
  in the same batch still needs a user turn after it.

## Recommendation

B, reached through A.

1. Do A's header now: it is a prompt and formatting change in
   `packages/harness/src/agent/runtime/FollowUps.ts` and
   `packages/harness/src/agent/runtime/deliveryEnvelope.ts`, and it removes
   the "everything is the user" reading for every sender kind, the person's
   own messages excepted.
2. Then move child reports to B: `executions wait` with no target answers
   "whatever is waiting for me" (reports and run-sent messages), the turn
   boundary writes the one-line notice instead of the envelope, and the
   awaited paths stay as they are. The person's messages and host notices
   stay in the user turn, where they belong: a person is not a tool.
3. Refuse C. It trades a role label for protocol fragility on exactly the
   route the owner uses.

Step 2 changes what a stored run's next request looks like, not a stored row:
`followup.queued` and `followup.consumed` already record a report answered by
a call (`answered`).

## Related: asking the person

The owner's second note belongs to the same picture: instead of reviewing
everything a run does, a run asks the person through explicit tools for what
needs their attention. The request set is already closed
(`RequestPayloadSchema`, `packages/harness/src/shared/schemas/request.ts`),
and `ask_user_question`
(`packages/texra/src/tools/userQuestion/UserQuestionTool.ts`) is the shape to
generalize: the person is one more addressee a run dials, with a call that
blocks until answered. What remains to decide is which of the current request
kinds (`bash`, `toolEdit`, `proposal`, `planApproval`) become such calls and
which disappear with blanket review. That is a design pass of its own and is
not started here.
