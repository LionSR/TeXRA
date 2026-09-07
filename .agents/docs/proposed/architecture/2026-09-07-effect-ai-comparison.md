# Native model and runtime: comparison with Effect AI and effect-agent

Status: proposed

Date: 2026-09-07. Source review of PR #11997 after rebasing onto main
`5484f99e4e507b5a57f8f295c900c9770450fd69`. This assessment identifies remaining
implementation obligations and useful design choices; it does not establish
live-provider parity or crash-recovery correctness.

The principal remaining debt is the unfinished runtime replacement. The native
model package has useful contracts, but its six provider factories still have no
application generation callers. Completing configured acquisition, both agent
programs and durable execution has greater value than adding another general tool
or stream abstraction. Effect AI and effect-agent provide concrete examples to
study without adopting their model, tool, or persistence frameworks.

## Sources and scope

| Repository                  | Exact revision                             | Local checkout                            | Relevant version                                 |
| --------------------------- | ------------------------------------------ | ----------------------------------------- | ------------------------------------------------ |
| Effect, including Effect AI | `2600f62f4532026928454dcea8d1c48557b3f942` | `/tmp/texra-effect-ai-2600f62f-20260907`  | `@effect/ai-openai` 4.0.0-rc.112                 |
| effect-agent                | `b07d8f638849d8367dc4d3449d72966a072d7e82` | `/tmp/texra-effect-agent-review-20260907` | engine/thread 0.1.0-beta.54; Effect 4.0.0-rc.112 |
| TeXRA                       | `92c71b8317a3d37407412647880a5470877a7b7f` | PR #11997 integration worktree            | Rebased implementation before this report        |

The effect-agent revision differs from the historical revision in the earlier
architecture studies. Conclusions below concern these exact checkouts. The
[current delivery plan](2026-09-06-effect-runtime-delivery-plan.md),
[runtime proposal §0.1](2026-09-04-agent-runtime-on-effect.md), and
[joint contract](2026-09-06-llm-runtime-contract.md) govern the remaining work;
superseded sketches do not introduce an old-flow importer or an internal Promise
adapter.

## Required before the integrated replacement is complete

### Persist tool progress at the individual call boundary

TeXRA executes a batch inside
[`ToolUseDispatchNode.ts`](../../../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts),
while [`persistedFlow.ts`](../../../../src/agent/node/persistedFlow.ts) checkpoints
the node's resulting state. A node checkpoint alone cannot identify which external
calls finished when execution stops inside the batch. This is an existing
replacement obligation, not a newly reproduced regression in the native providers.

Effect-agent explicitly
[commits the completed response before executing its calls](https://github.com/danieljvdm/effect-agent/blob/b07d8f638849d8367dc4d3449d72966a072d7e82/packages/engine/src/internal/agent-runtime.ts#L5747-L5762).
Its [recovery rules](https://github.com/danieljvdm/effect-agent/blob/b07d8f638849d8367dc4d3449d72966a072d7e82/packages/thread/src/Recovery.ts#L204-L218)
distinguish calls prepared without a recorded outcome from calls that can safely
resume. Uncertain external effects require reconciliation or an unknown outcome;
a missing result is not permission to execute the operation again.

TeXRA should implement the proposal's per-call intent, intermediate transitions,
immutable settled attachments and final logical result. SQLite-backed
`SessionEvents` and `Database.appendAll` already exist on main. Extend that store
with the private execution records and recovery fold; do not introduce a second
database or persist a second transcript.

### Make follow-up consumption and child settlement durable

[`ToolUseFollowUpQueueManager.ts`](../../../../src/agent/followUp/ToolUseFollowUpQueueManager.ts)
uses an in-memory deduplication set before enqueueing.
[`followUpMessages.ts`](../../../../src/agent/followUp/followUpMessages.ts)
installs messages and then invokes the consumption callback.
[`childRunLoop.ts`](../../../../src/agent/runtime/childRunLoop.ts) persists child
results separately from their delivery. These operations do not themselves form
the atomic installation and acknowledgement required by the proposal.

Effect-agent's
[input recovery evidence](https://github.com/danieljvdm/effect-agent/blob/b07d8f638849d8367dc4d3449d72966a072d7e82/packages/thread/src/Recovery.ts#L97-L134)
and [paired child-join and tool-settlement records](https://github.com/danieljvdm/effect-agent/blob/b07d8f638849d8367dc4d3449d72966a072d7e82/packages/engine/src/internal/agent-runtime.ts#L8221-L8231)
are useful examples. TeXRA needs stable identities, acknowledgement of exactly the
reserved inputs, and one durable child settlement with accounting. The same
requirements apply to workflow scripts; their separate journal is still present.

### Connect the canonical contract to actual model callers

`ModelFactory.ts` still selects the old handlers. `helperModel.ts` still needs a
session to construct its handler/client, and all four helper callers use it.
The editor's Grant operation is the sole application generation consumer of the
new acquisition contract. Both old graph programs, ambient run context and
Promise-based launch/resume paths remain active.

The next implementation should capture route, credentials/account and allowed
controls together, then convert the helpers with their prompt placement, context
admission and retry policy. Both agent programs must follow with the private
execution records and deletion of their old machinery. Completed-response
validation and persistence must precede local dispatch. Effect-agent's explicit
response-commit ordering is a useful acceptance example for this boundary.

## Lessons from OpenAiTool

[OpenAiTool.ts](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/ai/openai/src/OpenAiTool.ts)
distinguishes provider-defined tools that need local handlers, such as ApplyPatch,
LocalShell and Shell, from hosted tools such as CodeInterpreter and WebSearch.
Provider-specific encoding and execution ownership are independent properties.

TeXRA's current native tool definition represents ordinary functions, and Responses
lowers every such definition to `type: 'function'`. The old handlers still support
hosted OpenAI search and Anthropic search/fetch. This is a documented capability
gap to close before retiring those routes. Extend concrete tool variants when
implementing those capabilities; a general toolkit framework is not necessary.
Provider approval identifiers must also remain distinct from normalized local
call identities when implementing hosted MCP approvals.

Effect's Toolkit provides schema-driven argument decoding and result encoding,
but its raw-JSON-schema branch passes arguments through. Adopting it would not
supply missing validation for TeXRA's JSON schemas. TeXRA already validates tools
with Zod at `src/tools/core/base.ts` and has a common result envelope. Preserve
those authorities instead of maintaining a parallel set of Effect schemas.

Do not copy Effect AI's local dispatch into the model package. Its LanguageModel
can evaluate approvals and dispatch while processing provider parts. TeXRA's
contract deliberately requires a validated, committed completed response first,
with approval policy owned by the runtime.

## Narrow improvements worth considering

- **Expose useful retry evidence without retrying automatically.** The native
  OpenAI error retains status and request identity, but retry headers remain in
  the SDK cause. Effect AI's
  [error conversion](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/ai/openai/src/internal/errors.ts#L187)
  illustrates extracting rate-limit evidence. A small normalized field could let
  runtime policy use it without inspecting SDK classes. Its numeric-only parser
  should not be copied without checking the selected protocol's header forms.
- **Reduce repeated reader cleanup only if semantics remain exact.** Google and
  OpenRouter repeat reader cancellation, duplicate-failure suppression and lock
  release. There are two concrete consumers, so a small shared implementation may
  be justified. However, Effect's
  [ReadableStream finalizer](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/Channel.ts#L1846-L1848)
  either suppresses cancellation failures or only releases the lock. It is not a
  replacement for TeXRA's preservation of distinct cleanup defects and abort order.
- **Consider whole-batch validation as a policy change.** Effect-agent resolves
  tool names and decodes arguments before preparing execution. TeXRA currently
  validates each call when dispatched, so an earlier valid write may precede a
  later invalid call. Prevalidation could avoid that case, but changes existing
  semantics. Preserve read-only parallel groups, barriers and duplicate-result
  order; this is not a confirmed bug requiring an incidental refactor.

Tool-argument progress events are another possible feature, but need an actual
presentation consumer. Partial arguments must remain observations, never
executable calls. Neither these events nor a larger recovery-state union should
be added merely because the reference implementation has them.

## Verified

Hosted tools, selected media/upload/compaction paths and Google background
execution remain incomplete. Counting, continuation and background cancellation
still need runtime consumers and accounting. The proposal also requires real
restart and multiprocess checks, three-host and packed-SDK operation, and measured
cold-open, memory, stop, replay and storage-growth budgets. Local provider tests
do not discharge these obligations.

Three independent source reviews covered tools, streams/errors, and runtime
recovery. The response-commit ordering, ambiguous-call recovery, follow-up
installation and ReadableStream finalizer were then checked directly. No new
provider-streaming defect was confirmed in this bounded inspection. The external
checkouts were not built, and no live provider or external side effect was run.

The rebased TeXRA source passed formatting, full type checking, extension build,
lint and the repository guards. Vitest passed 9,351 tests with six skipped across
766 passing files and one skipped file, using Node 22.23.2 and four workers
(429.06 seconds). These results apply to the pinned TeXRA source above; this report
adds documentation only.
