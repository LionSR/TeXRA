# Architectural review of the September 6 studies

Status: proposed

Date: 2026-09-06. Verdict: retain the direction; revise four contracts before treating it as an implementation specification.

Reviewed: the [decision study](./2026-09-06-agent-architecture-study.md), [runtime study](./2026-09-06-agent-loop-architecture-study.md), [LLM package study](./2026-09-06-llm-package-architecture-study.md), and [HTML explorer](./2026-09-06-agent-architecture.html). The review concerns the proposed architecture, not a reproduced production defect. The studies explicitly describe a recommendation; passing their HTML and link checks does not validate the architecture.

TeXRA source in the studies is `cc22843af3fa7d8457b6899266a6e04bf15067e9`. Live main had advanced to `89d5942cee5c0f9cfec85dc6e99273cec4c80b69` when reviewed. The inspected handler, tool, and September runtime-proposal files cited below are unchanged between those revisions. The existing four external source pins remain the comparison baseline; this review does not assert a new exhaustive survey of upstream heads.

## Product direction: let stronger models improve the strategy

The owner's clarification changes the emphasis of the recommendation: useful domain programs survive the move away from PocketFlow. In particular, preserve the reflection pipeline itself: its stages, ordering, response continuations and round structure. Retaining only the `runReflectionFlow` entry point would not satisfy that requirement. Deleting node classes is an implementation consequence, not the product objective. A better model should solve harder TeXRA tasks through the same runtime and capabilities, including within the structured reflection pipeline.

This is a proposed product direction, not an established performance result or authorization to remove existing workflows. The current [tool-use loop](../../../../src/agent/implementations/flows/tooluse/ToolUseRoundFlow.ts) already lets the model request tools repeatedly until it ends its turn (1–12). We should build on that capability. We are not introducing model-directed tool use for the first time.

### Keep the programs; replace the composition machinery

The actual PocketFlow-derived [kernel](../../../../src/agent/node/index.ts) stores an optional services object, checks at runtime whether it was populated, clones nodes, and propagates the object with `setServices()` before execution (29–45, 124–147). The problem is not specifically constructor injection: [ToolUseRoundFlow](../../../../src/agent/implementations/flows/tooluse/ToolUseRoundFlow.ts) constructs its nodes without those services (43–73). Its comment calls them “params,” but the kernel supplies them through `setServices`.

[BaseFlowServices](../../../../src/agent/core/flows/BaseFlowServices.ts) and [CycleServices](../../../../src/agent/core/flows/CycleServices.ts) accumulate model selection, run identity, configuration, prompt data, mutable run/workspace state, logging and callbacks in inherited bundles. [runReflectionFlow](../../../../src/agent/implementations/flows/reflection/runReflectionFlow.ts) assembles another bundle around those values and its document managers (148–200). Recreating that entire bundle as one Effect `RunContext` would retain much of the coupling.

Compose real capabilities with Effect services and layers at the owning workspace/run boundary. Pass ordinary data explicitly to programs. Keep authoritative state in its agreed owner rather than exposing another mutable copy through every service. A function should request the capabilities it actually uses; it does not need a new service interface or layer merely because it replaces a node.

| Current responsibility | Proposed expression                                                                 | Why it remains                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Tool batch dispatch    | An Effect program over canonical calls, tool capabilities and settlement operations | Ordered mutations, concurrency, interruption and result pairing are real execution policy    |
| Model invocation       | TeXRA's LLM turn operations composed with runtime admission, retry and accounting   | Provider I/O and the decision to authorize another attempt have different owners             |
| Response processing    | Explicit normalization and committed runtime transitions                            | Provider evidence and tool calls must survive interruption coherently                        |
| Reflection pipeline    | A first-class Effect program preserving its stages, ordering and round structure    | Document preparation, response continuations, output handling and round policy remain useful |
| Graph lifecycle        | Ordinary program composition plus durable I/O phases                                | `prep/exec/post`, string successors and service propagation need not define the application  |

The [dispatch node](../../../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts) already bypasses the generic `_exec` implementation to own its batching and avoid automatic tool retries (146–200). That is a concrete example of useful behavior fitting more directly in a named program. The September runtime proposal also explicitly says these bodies move and that invocation retry/gate/credential logic does not simply disappear (775–790).

### Preserve the reflection pipeline alongside model-directed tool use

Keep **two first-class orchestration programs over shared Effect-native capabilities**: the tool-use loop and the reflection pipeline. Each retains its own control structure and composes the shared capabilities directly.

The current [reflection orchestration](../../../../src/agent/implementations/flows/reflection/runReflectionFlow.ts) explicitly orders these stages (288–297):

1. Prepare context.
2. Count TeX content.
3. Extract media.
4. Run the response cycle.
5. Process output.

The [response cycle](../../../../src/agent/implementations/flows/reflection/ResponseCycleFlow.ts) has its own preparation, invocation, processing, continuation and finalization structure (554–592). [RoundPersistedFlow](../../../../src/agent/implementations/flows/reflection/RoundPersistedFlow.ts) owns repetition, continuation decisions and round transitions (128–250). Preserve those semantics as explicit Effect programs. The existing configured rounds, template handling, compilation/output acceptance and stopping behavior remain part of the pipeline contract. Replacing PocketFlow does not authorize changing them.

Both orchestration programs use TeXRA's LLM package and the agreed runtime services for admission, tools, accounting, interruption and recovery. They can share capabilities and consequential operations without being forced into one universal loop or maintaining separate persistence engines. The implementation may replace node lifecycle hooks and service propagation with direct Effect composition while keeping the pipeline recognizable.

More model autonomy can improve reasoning, tool choice and delegation inside the places each program already delegates to the model. In the general tool-use flow, the model can choose the next investigation or verification step. In reflection, it reasons within the pipeline's stage and round contract. Any future change to that contract is a separate product decision, not an implied consequence of being Effect-native or pursuing more capable agents.

The runtime owns the execution facts and constraints: user permissions, resource limits, cancellation, ordered effects, settled tool outcomes and recovery. An explicitly requested workflow or acceptance requirement remains binding. The model cannot turn a failed compilation into a successful one by declaring completion.

Invest in the observations that let the model make these decisions: useful compiler diagnostics, precise file/diff results, rendered-document inspection and attributable subagent results. TeXRA already has domain and delegation tools; the design task is to make the capabilities coherent and composable, not to claim they are all missing. Skills and instructions can supply domain knowledge and suggested procedures. Deterministic programs should implement operations whose correctness comes from executing a defined procedure.

The LLM package should support that direction by preserving provider capabilities: reasoning continuity, parallel tool calls, media, streaming and background operations. A clean public abstraction must still let a newly capable provider express something useful. It should not force every model into a text-plus-JSON lowest common denominator, nor require the runtime to understand raw SDK payloads.

### What to do next

1. Record the reflection pipeline and tool-use loop as first-class programs in the joint runtime–LLM design. Map existing stage responsibilities and dependency requirements before porting them. Preserve the reflection stage order, continuations, round policy and output behavior.
2. Make a real reflection path concrete against the new LLM turn boundary and shared runtime capabilities, including continuation, output handling and interruption/resume. Check the shared boundary against the tool-use consumer and the R1–R4 examples below. Use those paths to settle the contracts rather than designing a general framework in isolation.
3. Evaluate whether stronger models improve completed task quality and reduce user intervention within each orchestration program. Also record cost, elapsed time and false completion claims. More autonomy is a hypothesis to evaluate, not a quality measurement by itself or a reason to remove the reflection pipeline.

This work belongs within the existing runtime/LLM cutover and its ownership boundaries. The independent contribution now is this contract and product-direction review; implementation ownership still needs a current coordination check.

## Findings

The [joint runtime/LLM implementation contract](./2026-09-04-agent-runtime-on-effect.md#01-current-implementation-contract-runtime-and-llm-package)
now records the required revisions below in the runtime proposal. This resolves
where the contract is specified; it does not close R1–R4's implementation
acceptance scenarios or claim provider parity.

### R1 — High: the completed-turn API does not define the background acceptance boundary

**Location:** LLM study lines 65–82 and 113–117; runtime study lines 86–87 and 108.

The contract says `generateTurn` produces a completed result and `streamTurn` produces incremental events plus a terminal result. It also requires a remote operation ID to be committed before retrieval continues. The latter is a valuable requirement, but the proposed API does not specify which operation exposes that acceptance, how a non-streaming caller receives it, or what prevents polling from proceeding before the runtime's commit.

An implementation could satisfy the completed-result signature by creating a background operation and polling internally until completion. The runtime would then have no durable handle during that interval. Merely adding an observational callback or buffered progress event would not establish the required ordering.

The recoverable handle also needs more than an ID. Today's [BackgroundRunLifecycle](../../../../src/agent/modelHandlers/support/BackgroundRunLifecycle.ts) retains retrieval parameters and an absolute deadline alongside the ID (lines 151–158, 226–237). `tryResume` reuses those values before retrieval (303–349). The [Interactions handler](../../../../src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts) prioritizes an already accepted operation even after background settings change (1623–1632). These are current execution semantics that the new public contract must allocate explicitly; they are not evidence of existing cross-process durability.

**Required revision:** make remote submission and observation explicit operations. For background-capable models, submission returns either a completed result or a serializable accepted-operation handle. The runtime commits the handle before calling the observation/retrieval operation. Include protocol/deployment identity, the required retrieval data, attempt correlation and original deadline; re-resolve credentials under an explicit binding rule without storing secrets. A one-shot convenience consumer can compose these operations, but the durable runtime uses the visible boundary. Do not keep the completed-only contract and assume a hidden observer will supply durability.

Also specify what cancellation does to the local observation versus the accepted remote operation. A remote cancel request and a confirmed remote cancellation are different facts.

**Acceptance scenario:** stop after acceptance, restart under changed background settings, and resume the original remote job without creating a new one or resetting its deadline. A failure before any handle was received remains explicitly ambiguous.

### R2 — High: the new tool-settlement table omits state changes and immutable attachments

**Location:** runtime study lines 88–91 and 112; LLM study lines 96 and 107; HTML “Execute and settle tools.”

The new table promises a result bound to a call/attempt and says committed results are never repeated. It does not define the accompanying tool-state effects or immutable attachment materialization. Without that definition, “result committed” is not enough to reconstruct the result of a TeXRA tool.

For example, [TodoTool](../../../../src/tools/todo/TodoTool.ts) updates `workPlanState` and returns a short success message (41–60). Replaying that text cannot reconstruct the actual todo list. [PlanTool](../../../../src/tools/plan/PlanTool.ts) changes plan state before waiting for approval (135–158), so some state transitions must be durable before the final tool result even exists. The [dispatch node](../../../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts) also records file interactions and media separately from the tool's textual output (421–436, 492–503).

Attachments make the same gap visible for model input. [ToolFileAttachment](../../../../src/shared/schemas/toolResult.ts) can contain a `Uint8Array` (23–29); [loadAttachmentBuffer](../../../../src/agent/modelHandlers/utils/toolAttachmentUtils.ts) can read the current workspace path (133–145). A path-only result resumed after the file changes is not the original tool observation.

The [September 4 runtime proposal](./2026-09-04-agent-runtime-on-effect.md) already states the stronger contract: per-call mutations, terminal display facts and results commit together; attachments are captured as immutable bytes or explicit omissions before settlement; pending delivery never rereads the workspace path (151–198). The new studies must carry that contract forward explicitly. They should not read as a simpler replacement that silently omits it.

**Required revision:** define a durable tool settlement containing the response/call/attempt identity, outcome, relevant state operations, immutable attachment payloads or explicit omissions, and display correlation. Commit final state effects and terminal facts atomically. Model intermediate state such as a plan awaiting approval as a named durable transition rather than postponing everything until return. Do not record a whole shared-state copy while other calls can change it.

Canonical LLM tool messages should contain model-visible results; they should not absorb TeXRA's entire runtime state mutation vocabulary. The runtime applies those state operations and constructs the canonical messages from the same settlement evidence.

**Acceptance scenarios:** resume after a todo result commits but before the next model turn; resume after an attached file is changed or deleted; resume while a proposed plan awaits approval. Preserve the settled state and original observation without rerunning the completed tool.

### R3 — High: a portable request is not yet the exact admitted invocation

**Location:** LLM study lines 65–90; runtime study line 86; decision study's joint-contract and ledger sequencing rules.

The executable model contains generation defaults and process-local behavior, while `TurnRequest` is model-independent portable data. The runtime promises to record the exact request before generation. No preparation boundary defines how defaults, capability-dependent choices and protocol lowering become fixed before that record.

If the ledger stores only the portable request plus a model ID, the same record can resolve to a different token limit, reasoning setting, structured-output strategy or continuation route after settings or provider code change. If each runtime caller manually resolves those options to avoid that problem, provider construction leaks back into the runtime and recreates the wide handler boundary elsewhere.

Current code shows why these choices matter: [ModelHandler](../../../../src/agent/modelHandlers/ModelHandler.ts) resolves a mode-dependent output allowance (365–372), and [Interactions generation](../../../../src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts) adjusts output limits and selects full versus incremental history before dispatch (1543–1621). These behaviors need new owners and a definite order, not just relocation into different files. OpenCode's implemented [request preparation and defaults resolution][oc-prepare] is useful evidence of that separation, although its facade is not the API we should copy.

**Required revision:** distinguish author-facing `TurnRequest` from the fully resolved invocation admitted by the runtime. Have the package resolve supported defaults and validate protocol options before the runtime records generation intent. Persist non-secret effective controls, protocol/model/deployment identity, immutable history/content references, and the continuation binding. Lowering must be deterministic over that recorded input under an explicit protocol-version policy.

Do not persist another complete transcript or SDK object merely to obtain an “exact request.” Reuse the existing immutable message/content references. If a changed configuration or protocol version requires different input, it is an explicit newly admitted attempt, not silent reinterpretation of an old one. Fresh authentication material is resolved at execution under the saved route/binding; it is not part of persisted request content.

Preparation must also distinguish pure conversion from external operations. [Attachment upload](../../../../src/agent/modelHandlers/utils/toolAttachmentUtils.ts) performs real provider I/O (103–130). A file upload cannot be hidden inside something advertised as side-effect-free request compilation. Keep its receipt/lifetime policy explicit without inventing a second history or asset authority.

**Acceptance scenario:** prepare and record a request, change model defaults, then reload it. Its admitted semantic input remains fixed. If it cannot be executed under the supported protocol version, the runtime reports that fact or admits an explicit replacement attempt.

### R4 — High: continuation metadata is not bound to the history it covers

**Location:** LLM study lines 96–109 and its provider-fidelity matrix; runtime study lines 88–93.

The proposed envelope preserves provider/model/deployment identity and opaque data. That is necessary, but it does not define which conversation prefix a server anchor covers, what compaction or branching invalidates, or how a complete tool exchange maps to provider ordering.

The same model and deployment can have two different histories. Reusing a server anchor after replacing or branching that history can repeat old content, omit new content, or attach tool results to the wrong provider conversation. “Preserve the ID/signature” does not establish that it remains valid for the new request.

Current [ServerChainState](../../../../src/agent/modelHandlers/support/ServerChainState.ts) tracks the covered message/step count as well as the anchor and explicitly invalidates the anchor for compaction (1–19, 74–93). [Interactions](../../../../src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts) sends only newly appended client-input steps when chained; resending model-generated function calls is a different wire operation (1599–1621). Its batch contract preserves thought signatures across the whole group of function calls (735–747). The [dispatch code](../../../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts) also keeps approval feedback inside tool-result content to avoid changing Anthropic's reasoning/cache behavior (608–612).

**Required revision:** separate three kinds of provider evidence:

1. Opaque data attached to exact content parts, such as a signed reasoning block.
2. A completed conversation continuation bound to an immutable history prefix and its protocol encoding.
3. An in-progress remote operation handle bound to an invocation attempt, as in R1.

Define the validity/invalidation rules for each. Compaction must install replacement history and invalidate or replace its old continuation atomically. A model switch or branch cannot reuse a continuation merely because its provider label matches. Specify a canonical tool-exchange grammar with response identity, ordered calls, and one settlement per call; providers lower the complete exchange without runtime provider-specific branches or fabricated outcomes. Provider call IDs alone are not a global durable identity.

This does not require retaining the old raw SDK message union. It requires proving that the new canonical representation can encode the important behaviors the union currently carries.

**Acceptance scenarios:** two parallel tool calls with signed reasoning and a restart between settlements; a compacted Interactions conversation whose old anchor is still present in saved provider data; a branch continuing the same model from a different prefix. Assert exact request semantics, not merely successful JSON serialization.

## What I would retain

The fundamental split is good: TeXRA owns its LLM package; Effect owns in-process execution mechanics; the runtime owns tools and continuation decisions; one ledger owns recovery; document policy stays outside providers. None of the findings justifies reintroducing PocketFlow, an external LLM framework, a handler facade, or a second durable engine.

The aggressive cutover is also a reasonable direction. Internal contract changes and provider conversions can be developed in bounded pieces on the shared integration target while the release exposes one active implementation. Coordinate changes to the existing lane-D contract instead of treating this review as authorization to rewrite the substrate independently.

One lifetime rule should be made explicit while resolving R1/R3: an invocation binds its selected model/credentials and resource scope; a later model switch affects a newly admitted invocation. An old in-flight acquisition or completion must not overwrite the new selection. [ModelCell](../../../../src/agent/runtime/ModelCell.ts) already guards retired client builds and rebinding (82–121). Effect [Scope][effect-scope] provides resource management, but the ownership policy still belongs to the design. This is a refinement of the proposed scope boundary, not a reason to preserve that class.

## Are we going to have the best design everywhere?

That is not established, and this design intentionally makes at least one tradeoff. OpenCode's [new runner][oc-runner] can start local tools when a complete tool-call event arrives, while the response stream is still active. TeXRA's proposed gate waits for the full validated response and its durable commit. The latter offers a simpler recoverable batch boundary but gives up that tool-start overlap. It cannot be described as dominating both choices on every axis without measurement and a different execution protocol.

The useful target is specific:

| Area                 | Architectural ambition                                                                           | What would establish it                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider fidelity    | New APIs expose useful native capabilities quickly without leaking SDK types through the runtime | Responses, Interactions, signed reasoning, hosted tools and media represented by the same package boundary; concrete round-trip/request fixtures           |
| Durable recovery     | Accepted remote work, tool outcomes and conversation state remain coherent across interruption   | The R1–R4 scenarios plus existing stale-owner and output-reconciliation checks                                                                             |
| Document workflows   | Reflection/output work remains direct and understandable outside the LLM protocol                | Real helper, tool-use and document consumers use the same package without handler-era hooks                                                                |
| Provider development | Adding or extending a provider is localized                                                      | A real provider feature changes its implementation/capability declaration without editing the runtime loop or adding another application-level option path |
| Latency and cost     | Durability has a known, acceptable cost                                                          | Measure first text, first tool start, turn completion, duplicate attempts and persistence work on actual TeXRA flows                                       |
| Simplicity           | Remove competing authorities and unnecessary interfaces                                          | Dependencies are composed once, data and capabilities are separate, and useful programs have direct owners; class deletion alone is insufficient           |

There is no cross-product benchmark behind a “best” claim today. The source census measures the current code's size; the offline Effect probe measures another library's call boundary; the HTML checks measure presentation. None establishes provider parity, recovery correctness or runtime performance.

## Recommended next design artifact

Replace the remaining prose placeholders with one joint contract document containing:

- Author input versus resolved invocation data, including exact history/content references.
- Submission, acceptance, observation and terminal outcomes, including deadlines and cancellation.
- Canonical messages/tool exchanges and separate content, conversation and operation continuation evidence.
- Durable tool state transitions and settlement transaction groups.

Work those contracts through the hard current paths: Responses background generation, Interactions signed parallel tool results with compaction, and a tool that mutates work-plan state and returns a file. These examples should determine the API shape before broad provider conversion. Keep the HTML as a projection of the resulting decisions, not the authority for them.

## Review limits

This was a source-grounded architectural review. It found specification gaps and concrete counterexamples permitted by the current sketches; it did not reproduce new production bugs, run providers, benchmark latency, or execute the proposed engine. The original studies and HTML were left unchanged so these findings can be reviewed against their exact text.

[oc-prepare]: https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/llm/src/route/client.ts#L136
[oc-runner]: https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/core/src/session/runner/llm.ts#L249
[effect-scope]: https://github.com/Effect-TS/effect/blob/77f85fe1613348f5c990016b49dc97e252576c82/packages/effect/src/Scope.ts
