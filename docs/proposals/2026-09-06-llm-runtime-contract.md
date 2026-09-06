# TeXRA LLM and runtime: proposed joint contract

Date: 2026-09-06. Status: design draft; no implementation or runtime cutover is
authorized by this document.

**Build TeXRA's own Effect-native LLM package, and make its boundary usable by
both the reflection pipeline and the tool-use loop.** This draft proposes
concrete resolutions to R1–R4 in the
[architectural review](2026-09-06-agent-architecture-review.md). It refines the
[LLM package study](2026-09-06-llm-package-architecture-study.md) and supplies
amendments for the [runtime proposal](2026-09-04-agent-runtime-on-effect.md); it
does not introduce another runtime or persistence authority.

Source inspected at `2d986504584cde8b607393b3dbdfec85ce095ee6`, which includes
the studies merged in [#11947](https://github.com/LionSR/TeXRA/pull/11947).
References below describe code at that revision. Earlier external research
remains pinned by the studies'
[source manifest](evidence/2026-09-06-agent-architecture/source-pins.json); this
draft makes no fresh upstream-head claim.

## 1. Preserve the programs and their domain contracts

The reflection pipeline remains context preparation, TeX counting, media
extraction, response cycle, and output, in that order. Its response
preparation/invocation/processing/continuation/finalization structure and its
outer round policy remain explicit. They are visible in
[runReflectionFlow](../../src/agent/implementations/flows/reflection/runReflectionFlow.ts#L288),
[ResponseCycleFlow](../../src/agent/implementations/flows/reflection/ResponseCycleFlow.ts#L554),
and
[RoundPersistedFlow](../../src/agent/implementations/flows/reflection/RoundPersistedFlow.ts#L128).

Port those operations to Effect composition while preserving configured rounds,
template selection, continuation coordinates, output handling, compile feedback
and stopping behavior. A model retry is another attempt at an invocation, not
another reflection round. A model continuation is not a new user request.
Recovering a later stage must not restart earlier external work merely because
the program was reconstructed.

The
[tool-use loop](../../src/agent/implementations/flows/tooluse/ToolUseRoundFlow.ts#L31)
remains its own orchestration program. Its
[dispatcher](../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts#L146)
retains barrier ordering, bounded safe-call concurrency, duplicate handling,
interruption and result pairing. Reflection need not run through that loop to
use the same LLM package.

Both programs share provider operations and the agreed runtime capabilities.
Effect requirements express capabilities; ordinary function arguments carry
execution coordinates, request data and stage inputs. Compose capabilities at
their owning workspace/run boundary. Avoid replacing inherited service bundles
with one oversized `RunContext`, or introducing a tag/layer for every former
node. A configured model is an executable value with an appropriate resource
lifetime; it need not acquire a forwarding service merely to become
Effect-native.

## 2. Ownership and the two representations of input

| Owner                        | Owns                                                                                                                           | Boundary                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| TeXRA LLM package            | Canonical content, provider controls, protocol conversion, stream normalization, native provider operations and typed evidence | No session store, tool executor, reflection policy, billing settlement or platform singleton |
| Reflection/tool-use programs | Task/stage policy, request construction, continuation decisions and interpretation of results                                  | No SDK request/response unions or provider-specific message surgery                          |
| Existing runtime services    | Attempt admission, selected model binding, tool execution, interactions, accounting and ordered settlement                     | One owner for each operation; no new general workflow engine                                 |
| Agreed ledger/substrate      | Committed history, attempt evidence, state transitions, owner fencing and recovery reads                                       | One transaction/retention authority, shared by both programs                                 |
| Hosts/readers                | User input and presentation of redacted committed facts and transient progress                                                 | Display text cannot reconstruct model history                                                |

The public package accepts materialized canonical messages. It does not accept
database cursors or know how TeXRA stores a conversation. The runtime may
persist immutable references to those messages instead of copying the
accumulated history into every attempt row. On recovery it materializes the
exact referenced values before calling the package.

Zod owns these data contracts. The runtime's stored record composes the
package's resolved-control schema with its own history references and attempt
identity. It must not independently redeclare provider option fields. SDK
clients, services, fibers, closures and credential secrets never appear in
either persisted representation.

## 3. R3: resolve inputs before admitting generation

Distinguish these values:

| Value              | Contents and meaning                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TurnRequest`      | Author-supplied canonical system/content, tool definitions, generation/output intent and provider options. Some supported controls may be absent.                                                                                           |
| `ResolvedTurn`     | Materialized canonical input plus validated effective controls, protocol/codec version, requested model identity, deployment binding, execution mode and applicable continuation evidence. Resolving current defaults has already happened. |
| `InvocationRecord` | Runtime attempt/response identity and stage coordinates; the same resolved controls; immutable input/history references and generation deadline. It is the durable representation of the admitted turn, not a second transcript.            |

The package's preparation operation resolves defaults and capability-dependent
choices and validates the input. It performs no model generation, file upload,
filesystem read, credential refresh or network discovery. The caller supplies
materialized content and an already selected model configuration. Request-size
accounting is deterministic preparation; selecting a summarization or
native-compaction operation remains runtime policy.

Preparation returns `ResolvedTurn`. The runtime constructs and commits
`InvocationRecord` under the current execution-owner fence before generation can
start. The provider executor accepts resolved input without rereading
application settings or applying new generation defaults. Recovery reconstructs
that resolved input; it does not call author-input preparation against today's
defaults.

This boundary freezes the requested semantic input, not a provider's future
behavior. An external model alias can change implementation and generation is
not deterministic. Record the requested identity and any returned model/revision
information; do not claim an exact provider model revision when the API does not
supply one.

### Binding and version rules

A mutable route name alone is insufficient. Persist non-secret route settings or
an immutable configuration version and verify it when resolving the binding. An
endpoint/configuration change must not silently redirect an admitted request. If
the recorded route is unavailable, report that or admit a replacement.

- A deployment binding identifies the protocol, route and credential scope
  needed to execute or retrieve the operation. It contains no secret. Credential
  refresh may replace authentication material within that binding; switching
  account/project or protocol is a new admitted attempt unless the provider
  explicitly guarantees equivalent access.
- A model switch affects newly admitted work. An older in-flight response or
  client acquisition cannot overwrite the new selection or append itself to a
  different history. Preserve the retirement/rebind protections currently owned
  by [ModelCell](../../src/agent/runtime/ModelCell.ts#L82).
- Provider lowering uses the recorded codec/version policy and resolved
  controls. If the decoder/executor no longer supports that version, report an
  incompatibility or admit an explicit replacement. Do not silently reinterpret
  an old request. This does not require indefinite support for old internal
  formats.
- Transport-only details such as a freshly signed authorization header are
  resolved at execution. Semantic defaults, tool schemas, output allowance and
  reasoning controls are resolved before admission. An opaque HTTP request blob
  is not the public package contract.

Current [ModelHandler](../../src/agent/modelHandlers/ModelHandler.ts#L365)
applies a mode-dependent output allowance, while
[Interactions](../../src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts#L1543)
resolves limits and full versus incremental input. These are concrete decisions
that must acquire the above ordering.

### Uploads are external work

[Attachment upload](../../src/agent/modelHandlers/utils/toolAttachmentUtils.ts#L103)
performs provider I/O. It cannot be hidden in pure preparation. For a protocol
requiring uploaded assets, capture the canonical bytes first, execute the upload
as an explicit provider operation, and retain its receipt and binding before
admitting the generation that uses it. A missing/expired receipt requires a
recorded replacement asset operation and, where input changes, a replacement
invocation.

The receipt must distinguish remote identity from canonical content identity.
Retrying an ambiguous upload may create an orphan asset; it is not proof of
deduplication. The package classifies provider upload/retrieval behavior; the
runtime records the operation through the same substrate. Final asset-receipt
row naming and supported provider expiry behavior need to be settled with that
provider slice, not guessed in a generic request compiler.

## 4. R1: make background acceptance an executable boundary

The public API must distinguish foreground execution from accepted background
work. Proposed operation names are illustrative; their ordering and ownership
are the contract.

| Operation                                         | Contract                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareTurn(request)`                            | Produces resolved input without external I/O as specified above.                                                                                                        |
| `streamTurn(resolvedForegroundTurn)`              | Runs one foreground attempt and emits normalized progress plus one authoritative completed result. It never executes local tools or starts another generation.          |
| `generateTurn(resolvedForegroundTurn)`            | Collects the same execution/normalization path to one result; it is not another provider implementation or a second subscription to the stream.                         |
| `submitBackground(resolvedBackgroundTurn)`        | Returns `Completed(TurnResult)` or `Accepted(RemoteOperation)`. Returning an accepted handle ends this operation; it does not continue into a hidden poll loop.         |
| `observeBackground(operation, observationPolicy)` | Retrieves/observes that accepted operation under the caller's deadline and emits normalized progress and a terminal outcome. It never creates a replacement generation. |
| `cancelBackground(operation)`                     | Reports the provider's cancellation evidence. Request submission, acknowledged cancellation and already-completed work remain distinct outcomes.                        |

The durable caller commits its generation admission before calling either
foreground execution or background submission. For `Accepted`, it commits the
remote handle before calling observation. No progress observer, callback, queue
notification or UI subscriber acts as the durability acknowledgement.

For foreground providers, an operation ID learned while streaming may still be
useful recovery evidence. Emit it explicitly and have the durable consumer
persist it before advancing its own consumption. A transport may have already
buffered later bytes; the claim is about local consumption and tool dispatch,
not stopping remote generation. If recoverable background semantics are
required, use the explicit submission boundary.

A stream is one execution, consumed once. Rendering and result collection share
that execution. Bounded transient progress can be coalesced; the terminal
result, recovery evidence and errors cannot be silently dropped. Ending the
stream without an authoritative completed result is failure/interruption, not a
successful partial turn. Incomplete tool arguments are never dispatchable.

The package's serializable `RemoteOperation` carries:

- Remote operation ID, protocol/codec identity and non-secret
  deployment/credential binding.
- The provider-specific retrieval parameters required to continue observing it.
- Any supported provider resume cursor and provider evidence needed to interpret
  the handle.

The runtime stores it in an `AcceptedOperationRecord` bound to the admitted
attempt and its immutable input/history identity, together with the original
absolute observation deadline. It supplies that deadline to observation on
reload. Runtime execution IDs, pipeline coordinates and database references do
not become required fields in the package's public provider handle. Reloading
the record must not reset its deadline.

The runtime chooses and persists the deadline policy at admission. This
explicitly tightens the current
[BackgroundRunLifecycle](../../src/agent/modelHandlers/support/BackgroundRunLifecycle.ts#L226),
which establishes its absolute deadline when it remembers a pending ID. The new
policy must account for submission time rather than silently granting a fresh
polling budget after restart.

Reaching a local deadline stops observation; it does not establish that the
provider cancelled the operation. An explicit extension of the observation
budget is its own runtime decision. Likewise, a missing/expired remote job can
justify a new attempt only through runtime retry policy. The package does not
turn retrieval failure into another create call. Today's
[tryResume](../../src/agent/modelHandlers/support/BackgroundRunLifecycle.ts#L303)
can signal a restart; preserve the provider classification while moving the
restart decision to its explicit owner.

An Interactions `requires_action` response can finish the model invocation and
supply tool calls even though the broader provider conversation awaits results;
[the current lifecycle](../../src/agent/modelHandlers/support/BackgroundRunLifecycle.ts#L74)
already distinguishes this serviceable status. The package returns that
completed turn. Runtime tool handling supplies the next exchange through the
same admission boundary.

### Recovery outcomes

| Last durable evidence                   | Permitted next step                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| No admitted generation                  | Prepare/admit according to the saved pipeline phase.                                                                                 |
| Admission, no accepted handle or result | Treat external outcome as unknown. Retry only under an explicit policy; absence of a handle does not prove the provider did no work. |
| Accepted handle, no result              | Resume observation under the recorded binding and deadline. Do not submit a new job automatically.                                   |
| Completed response                      | Reuse it and continue the saved pipeline stage or unsettled tools. Do not regenerate it.                                             |
| Local observation interrupted           | Keep the accepted job evidence. A reader detach is separate from execution cancellation.                                             |
| Cancellation requested but unconfirmed  | Retain uncertainty until provider evidence or an explicit runtime decision settles it.                                               |

Foreground/network retries, provider SDK automatic retries and runtime retries
must have one reviewable attempt/accounting meaning. Disable hidden generation
retries where necessary. Observing the same accepted job again is not another
generation attempt. Report unknown usage as unknown; record normalized usage
once with the terminal response and attribute it to the original
attempt/binding.

## 5. R4: separate content evidence, conversation continuation and remote work

One generic opaque field cannot express three different validity rules:

| Evidence                  | Bound to                                                                                                   | Validity rule                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Content evidence          | An exact canonical part and the provider/protocol that produced it                                         | Signed/encrypted values and their associated content stay unchanged and correctly ordered.   |
| Conversation continuation | An immutable input/history prefix and its protocol encoding, plus the remote anchor and deployment binding | Use only when the next input extends the covered prefix under a supported continuation rule. |
| Remote operation          | One admitted invocation attempt, input and binding                                                         | Retrieve/cancel that operation; it is not a reusable conversation-prefix token.              |

The runtime stores immutable history identity using the agreed ledger
references, with an explicit replacement/branch revision. The package receives
canonical input and the corresponding continuation evidence; it does not inspect
database commits itself. Runtime checks reference lineage, and the provider
module validates the protocol-specific relationship between that lineage and its
anchor/encoding cursor.

The package's continuation binding includes a canonical prefix boundary and a
fingerprint of the covered content and effective system input, computed using
the versioned codec's specified identity encoding. Runtime records associate
that binding with their immutable history references. Reusing message IDs with
changed content is insufficient. The fingerprint is a validity check, not
another saved transcript or a promise that the remote server retains its state
forever.

A provider's covered-step count is not necessarily the number of canonical
messages. Preserve the provider-owned encoding cursor with the continuation; do
not derive it by slicing the generic message list.
[ServerChainState](../../src/agent/modelHandlers/support/ServerChainState.ts#L1)
stores an anchor and covered count today, and
[Interactions](../../src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts#L1599)
selects newly appended client-input steps rather than resending model-generated
calls.

Compaction commits the exact replacement input, any runtime-injected context,
and invalidation/replacement of the old anchor in one batch. Branching from a
different prefix or switching protocol cannot inherit an anchor merely because
the provider/model label matches. Reuse on an exact immutable prefix is allowed
only when the protocol's branching semantics are supported; otherwise use the
full-input path or report incompatibility.

Invalidating a server anchor does not authorize stripping signed reasoning
parts. If the destination cannot represent mandatory content evidence, use an
explicitly selected conversion/compaction policy or fail with a typed
incompatibility. Never fabricate text or a tool completion to make the history
parse.

## 6. R2: settle tools as execution facts and model observations

Every completed assistant response has a runtime response identity allocated for
its attempt and an ordered canonical call list. Persist the normalized list once
before dispatch. A runtime tool key is
`(executionId, responseId, callOrdinal, toolAttempt)`; preserve a provider's
call ID separately. Provider IDs alone are not a global durable identity, and
reloading must not re-extract calls and synthesize different IDs.

Persist the dispatch classification and approval decision with the runtime call
record, separately from the package's canonical call. Recovery checks both that
record and current execution policy before retrying an unsettled call. Today's
[`parallelSafe`](../../src/agent/core/tools/ToolTypes.ts#L22) declaration
governs concurrency and duplicate partitioning; it does not by itself authorize
replay after a restart or a tool implementation change.

`ToolSettlement` contains:

- That runtime key and its original presentation/card correlation.
- The outcome: executed success/error, denied, cancelled before dispatch, or a
  recorded other disposition. An uncertain external outcome stays
  pending/unknown until policy resolves it.
- Model-visible result content, including approval feedback where the existing
  protocol contract requires it.
- Immutable attachments or explicit omission records.
- Only the call's relevant logical state operations, and a `duplicateOf`
  reference where current duplicate policy shares a primary result.

The ledger atomically commits final logical state operations, the tool result
and terminal presentation facts. A model-visible result and the runtime's
state-operation vocabulary remain separate schemas. The LLM package consumes
canonical results; it does not own TeXRA's todo, plan, usage or file-interaction
state.

Final logical state changes can be staged for settlement. Required intermediate
state must have an explicit durable transition before it is exposed.
[TodoTool](../../src/tools/todo/TodoTool.ts#L41) updates the todo state and
returns `OK`; restoring only that message loses the list.
[PlanTool](../../src/tools/plan/PlanTool.ts#L135) publishes a new plan before
waiting for approval. For that path, commit a `plan-proposed` tool transition
with its state operations and approval correlation before waiting. Resume
reattaches to the same pending approval; it does not propose the plan again or
invent an approval result.

The final plan settlement references that intermediate transition and applies
only remaining changes. Failure after a committed intermediate transition does
not erase it. Likewise, a failed tool may have completed some external actions;
its settlement must describe the actual result and relevant state, not assume
failure implies no mutation.

Approval answers target the same saved request, call attempt and pending state,
and are durably accepted once by the existing interaction owner. A stale answer
cannot approve a replacement proposal or a newer attempt. Reconstructing an
in-process wait does not create another approval authority.

Database atomicity does not cover filesystem writes, subprocesses or remote
mutations. Preserve intent before barrier dispatch and retain unknown outcomes
where no safe reconciliation exists. Do not attempt a transparent rerun merely
to reconstruct missing display state.

### Attachments and ordering

Use the runtime proposal's captured-base64 or explicit metadata-only-omission
representation for tool attachments. Capture bytes once before settlement; an
empty byte array is valid content. Preserve MIME type, description and
source-path metadata, but recovery never rereads that path to reconstruct a
settled observation. Reuse those settled bytes for later provider
lowering/upload. This retains the stronger existing contract in
[runtime proposal §2.1](2026-09-04-agent-runtime-on-effect.md#21-rows),
including its storage policy; it does not add another asset store.

Independent safe-call settlements may commit as they complete. Their logical
state operations must commute or execution must serialize them; a
whole-workspace snapshot captured during concurrent calls is invalid. The
provider-facing result batch is assembled in original call order after every
call has a settled disposition. Uncertain barrier outcomes cannot be silently
converted into successful results to unblock that batch.

Preserve the current
[duplicate partition rules](../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts#L121).
A duplicate settlement refers to its primary and does not repeat the primary's
state effects. If the primary is committed and a duplicate is not, materialize
the duplicate result from committed evidence without rerunning the primary tool.

### Canonical tool-exchange grammar

A completed assistant turn owns ordered content parts and its complete ordered
local-call list. Its exchange owns exactly one settled disposition for each
local call before the next ordinary generation. Hosted-provider work is
represented as already executed provider content and never enters the local
dispatcher.

The runtime joins the committed assistant response and settlements into a
canonical exchange. The provider module lowers the whole exchange, including
signed reasoning and required grouping, as one protocol operation. Preserve
[Interactions' whole-group requirement](../../src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts#L735)
and
[approval feedback inside tool results](../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts#L608).
The runtime has no `if Google`/`if Anthropic` branches for those encodings.

Persist canonical assistant/result values and references once. The new package
contract replaces the old provider-native pending-builder representation at
cutover; do not retain both histories. Version and validate the new payload
explicitly rather than silently changing the meaning of an existing `append`
row.

## 7. Ledger amendments required by these contracts

These are payload/row amendments within the existing event table and owner
fence, not a competing database or an operation-replay engine. Final row/version
names must be ratified with lane D before implementation; the proposed names
below make the missing facts visible.

| Proposed durable fact            | Proposed representation                                                                                              | Ordering/transaction requirement                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Generation admitted              | `model.attempt` with `admitted` payload containing `InvocationRecord`                                                | Commits before generation I/O; includes pipeline coordinates and expected history revision.                                    |
| Background accepted              | `model.attempt` with `accepted` payload containing `AcceptedOperationRecord` and its package-owned `RemoteOperation` | Commits before observation starts; does not duplicate request/history.                                                         |
| Completed model response         | Versioned canonical `model.message` payload referencing the attempt and response identity                            | Response, ordered calls, usage attribution and new continuation evidence commit together before dispatch or stage advancement. |
| Attempt failure/unknown outcome  | `model.attempt` with classified terminal or unresolved payload                                                       | Preserves available provider evidence; a retry receives a new attempt identity.                                                |
| Required intermediate tool state | `tool.transition`, initially for `plan-proposed`/awaiting approval                                                   | Logical changes and the corresponding interaction request commit before waiting/presentation.                                  |
| Final tool outcome               | Versioned `tool.result` plus existing terminal display facts                                                         | Result, attachments and remaining state operations commit atomically; prior intermediate transitions are referenced.           |
| Complete tool exchange           | The existing batch-install boundary references the source response and ordered settlements                           | Marks model-visible input installed once; does not persist a second native transcript.                                         |
| Compaction/history replacement   | Versioned `model.compaction`                                                                                         | Replacement history and continuation invalidation/replacement commit together.                                                 |

Append the required facts through the selected C6 cross-aggregate batch API.
Expected history revision and active attempt are checked alongside
execution-owner fencing when promoting a model result into the conversation. A
late result may need accounting/reconciliation, but cannot attach itself to
another invocation's history or mutate a newer model selection.

The execution fold derives pending attempts, accepted jobs, intermediate tool
state and settlements from these facts; snapshots retain bounded non-message
coordinates and references. No new checkpoint writer, `run_state` projection or
per-node cursor is introduced. The existing retention/redaction rules continue
to govern private execution data and public projections.

Asset-upload receipts and remote-cancellation evidence must use this same
substrate and be allocated concrete payloads with their provider slice. This
draft defines their ordering and binding requirements; it does not claim those
protocol-specific payload schemas are complete.

## 8. Walk the real hard paths before provider conversion

### A. Reflection with Responses background generation

1. Execute the existing preparation/count/media stages for the saved round and
   enter its response cycle.
2. Resolve the selected model, canonical request, controls and deadline; commit
   admission with round and continuation coordinates.
3. Submit once. If accepted, commit the operation handle and then observe it.
4. After a process restart, load the accepted attempt, preserve the original
   binding/deadline, and observe the same job. Changed defaults do not rewrite
   this request.
5. Commit the completed response and usage once; resume response
   processing/continuation and the existing output stage. Compile feedback and
   round advancement follow current pipeline policy.

Interruption after submission but before receipt remains ambiguous. A local
timeout with an accepted ID does not establish provider cancellation. These are
explicit outcomes, not reasons to restart the reflection round.

### B. Signed Interactions response with two local calls

1. Commit the completed assistant content, signed evidence, ordered call list
   and history-bound continuation.
2. Dispatch according to existing safe partitions/barriers. Commit call 0's
   result and its state effects.
3. Restart before call 1 settles. Reuse call 0. Decide call 1 from its recorded
   dispatch/intent and current policy; do not blindly rerun it.
4. Once both calls have settled dispositions, assemble the canonical exchange in
   call order. Let the Interactions module lower the signed group and proper
   client-input delta.
5. If compaction replaces the history before the next generation, atomically
   install the replacement and invalidate the old anchor; prepare a new
   invocation against that replacement.

The model's request for tools does not make their external outcomes
deterministic. An unknown barrier result requires a resolution decision before
the exchange can continue.

### C. Logical state plus file output, with an approval pause

Use the existing todo and plan behaviors as distinct cases; no claim is made
that either currently returns an attachment. A tool that also returns a file
exercises the same settlement boundary.

1. A todo result commits the actual list mutation alongside its small success
   message. Restart restores both without executing the tool.
2. A plan update commits its proposed plan and approval correlation before
   awaiting input. Restart restores that pending interaction and its state.
3. A file-producing result captures bytes or a documented omission before
   settlement. Changing/deleting the source path after the commit does not
   change the next model observation.
4. Provider upload may subsequently materialize those immutable bytes, under a
   receipt and binding policy; it never rereads the changed workspace file.

## 9. Integration and acceptance

At the September 6 coordination check,
[#11948](https://github.com/LionSR/TeXRA/pull/11948) owns the initial storage/C6
implementation, [#11960](https://github.com/LionSR/TeXRA/pull/11960) owns shared
trace folding, and [#11936](https://github.com/LionSR/TeXRA/pull/11936) owns the
SDK Effect surface. Those snapshots establish overlap, not permanent ownership
assignments. [#11868](https://github.com/LionSR/TeXRA/issues/11868) remains the
runtime tracking issue. This document takes no implementation ownership from
those changes.

This draft focuses on the LLM boundary and the durable facts that both pipelines
consume. The physical package extraction and canonical-history change must be
integrated with the runtime cutover rather than freezing its rows around the old
`IModelHandler` surface first.

Before implementation, consolidate accepted amendments into the LLM/runtime
specifications and link this draft as rationale. Acceptance requires:

- The existing reflection stage order, inner continuations, outer round limit
  and output policy remain intact.
- Foreground collected/streamed results share normalization, and neither path
  executes local tools.
- An accepted background job is committed before observation and survives reload
  with its original binding/deadline.
- A changed default cannot silently change an already admitted invocation;
  unsupported codec versions fail explicitly.
- Todo state, pending plan approval and settled attachments recover from
  committed facts.
- Signed parallel-call exchanges, compaction and branches obey their
  history/encoding binding rules.
- Existing ownership, cancellation, tool ordering, accounting and document
  reconciliation contracts continue to pass through both real consumers.

These are consequential acceptance scenarios, not a request for a unit test per
new type or stage. Extend existing suites at durable boundaries when
implementing the contract. No production test, provider call or proposed-engine
execution validates this unimplemented contract. Repository checks validate
existing behavior and document formatting/links; no live provider call or
proposed-engine execution was performed for this draft.
