# Native model development

This private workspace package is an unmerged development foundation for the
native model contract. Its exports point to TypeScript source; it is not a built
or published SDK artifact.

OpenAI Chat Completions implements text input and ordered local calls with complete
tool-result groups. OpenAI Responses also retains grouped assistant messages,
commentary/final-answer labels and completed encrypted reasoning. Google
Interactions additionally supports signed reasoning
and inline image, audio, video and document input; its tool results support text
and images. Preparation freezes the selected
deployment and protocol-specific controls; each foreground execution sends one
generation request without automatic retries. Stream completion collects the final
usage receipt when present and represents missing usage as unknown. Common usage
retains token totals, cache-read tokens and reasoning tokens; Anthropic also retains
its cache-creation breakdown and returned tier and geography. OpenRouter retains
reported billing, cache, server-tool and service-tier evidence. Further provider
usage categories remain incomplete, and pricing remains runtime-owned.

Google keeps the reported input, output, thinking, cache and total counters
unchanged, and retains `total_tool_use_tokens` separately as
`providerUsage.toolUsePromptTokens`. An omitted count stays null, including in a
partial receipt. The [Interactions reference](https://ai.google.dev/api/interactions-api?hl=en)
and [token guide](https://ai.google.dev/gemini-api/docs/tokens) describe separate
output, thinking and tool-use prompt categories. The provider package preserves
these observations without summing them into inferred billable counts.

Unsupported content fails explicitly; a protocol does not silently discard
reasoning or media that it cannot represent. Assistant content retains its originating
model binding, and a later request requires one ordered result per local call.
Google and Responses continuation verify an exact materialized prefix, not runtime
branch or replacement lineage; those remain runtime-owned obligations.

The extension-owned `acquireVscodeLanguageModel` implements the same `Model`
contract directly against the editor API. Acquisition captures one concrete model
and its exact vendor, ID and version; preparation records a separate live
acquisition identity. Execution never repeats model discovery, and a foreign or
retired acquisition is rejected. This prevents TeXRA from silently selecting a
replacement, but does not freeze the editor's underlying provider or account
mapping, which the [editor implementation resolves when sending](https://github.com/microsoft/vscode/blob/93cfdd489c3b228840d0f86ec77c3636277c93ea/src/vs/workbench/api/common/extHostLanguageModels.ts#L434).
Ordinary acquisition requires the editor to report access; the same captured
model is checked again immediately before each new send. The host-only
`request-on-send` consent mode is reserved for a direct user action; an unknown
access observation does not prove whether the model is missing or consent has not
yet been requested, as distinguished by the [pinned access API](https://github.com/microsoft/vscode/blob/93cfdd489c3b228840d0f86ec77c3636277c93ea/src/vscode-dts/vscode.d.ts#L20858).
However, the [pinned implementation currently returns true unconditionally](https://github.com/microsoft/vscode/blob/93cfdd489c3b228840d0f86ec77c3636277c93ea/src/vs/workbench/api/common/extHostLanguageModels.ts#L587),
with an unresolved TODO. Public access checks therefore cannot guarantee that
sending will not prompt for consent; rechecking does not remove this limitation.

Editor turns preserve ordered text, original complete tool calls and selected
image inputs, including exact MIME strings and empty captured bytes. Tool results
are text-only, in original call order; error results receive an explicit `Error: `
prefix because the API has no result-status field. The stable API has no system
role, so the system text is folded into the first user message. Other generation
controls, provider evidence, refusal replay and unsupported response parts fail
explicitly. Contiguous text fragments become one completed message, without
changing live deltas or their order around tool calls. Normal, non-cancelled EOF
completes consumption with null response ID,
returned model, fingerprint, finish reason and usage; it does not manufacture an
identified event or a stop reason. Stream cleanup cancels the editor token before
joining exposed pending operations and closing the iterator, preserving distinct
cleanup failures. The [public response API](https://github.com/microsoft/vscode/blob/93cfdd489c3b228840d0f86ec77c3636277c93ea/src/vscode-dts/vscode.d.ts#L20196)
exposes neither this missing metadata nor remote cancellation acknowledgement;
joining the local iterator is not such acknowledgement.
The settings Grant action uses this native acquisition and completion directly.
It first refreshes the model catalogue, retains the exact selected version and
enables the route only after successful completion. Its post-discovery deadline
cancels acquisition and generation; scoped cleanup is joined before the action
settles, without a bounded cleanup-time claim. Distinct cleanup failures remain
visible in the complete result. The former shared consent-request
operation is deleted. Configured agent and helper generation have not switched;
their old handler and language-model port remain deletion obligations.

Chat call arguments accumulate by the provider's call index. Original call IDs
and names cannot change; complete JSON-object arguments enter the terminal result
only after a successful tool-call finish and stream exhaustion. The normalized
assistant content places a text/refusal message before the ordered call list;
Chat history with text after a call is rejected rather than silently reordered.
Plain OpenAI Chat freezes the selected parallel-call setting and any required tool
during preparation. Tool definitions retain their parameters with `strict: false`.
Its configuration also states whether temperature is supported and which reasoning
efforts are allowed; these are selected facts, not deductions from a model name.
A null default temperature omits the wire parameter, while unsupported authored
temperature fails before transport. An absent authored effort inherits the selected
default; explicit null requests omission. Unsupported defaults, authored controls
and rehydrated prepared controls fail before a generation request is sent. Output
limits continue to use `max_completion_tokens`, as specified by the
[Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
Google also preserves a required named tool, but does not yet implement the
parallel-call control and rejects it when requested.

The same direct Chat implementation has explicit DeepSeek, Kimi and GLM protocol
branches. They preserve exact `reasoning_content` once in canonical reasoning and
replay it on retained assistant turns. Selected capabilities determine thinking,
effort, fixed or omitted temperature, reasoning retention and named-tool support;
there is no model-name inference or effort clamping. GLM accepts automatic tool
selection only, and all three reject the authored parallel-call control. Their
current scope includes text and ordinary local tools. Selected Kimi routes also
accept inline JPEG/PNG/GIF/WebP/BMP/HEIC/HEIF user images; selected GLM routes accept
JPEG/PNG. MIME spelling and base64 bytes are retained exactly, including empty
encodings, with ordered text labels. Image detail, tool-result images, audio,
video and documents remain unsupported in these Chat branches. Hosted execution,
background, storage, cache-lifetime and stopping controls are also
unsupported.

MiniMax uses the same Chat implementation and always streams SSE. Selected model, endpoint, reasoning-split choice and the existing
`max_tokens` field are retained. Plain reasoning and ordered reasoning details
remain separate, including reported empty values, as required for
[reasoning replay](https://platform.minimax.io/docs/api-reference/text-openai-api).
Local calls retain their original identities and order. Usage counts
remain independently unknown when absent, and reported character counts are
retained. Embedded nonzero provider status is a failure even under HTTP 200;
sensitivity observations are retained without inventing a filtering outcome.
The inherited stop, parallel-call and tool-choice controls preserve the selected
old request behavior; the current
[request schema](https://platform.minimax.io/docs/api-reference/text/api/openapi-chat-openai.json)
does not independently document those controls. MiniMax uses the same scoped HTTP reader and SSE parser as the other
Chat protocols. It appends text and reasoning fragments exactly, including repeated
fragments, assembles local calls by index and preserves their original identities.
Reasoning detail indices must form a contiguous ordered list; a missing index uses
that fragment's array position. A later fragment cannot change an observed detail's
identity. Plain reasoning and structured reasoning remain separate for replay;
when both arrive in one chunk, progress displays the structured reasoning once.
Usage observations are cumulative partial receipts, with absent fields retaining
previous observations. Completion requires a terminal finish and `[DONE]`.
Interruption aborts before joining reader cleanup; distinct cleanup defects survive.

The selected incremental route follows the incremental fields in the
[streaming schema](https://platform.minimax.io/docs/api-reference/text/api/openapi-chat-openai.json)
and the existing configured handler's fragment interpretation. The SDK guide's
example instead slices some cumulative text. Cumulative delivery is not supported
by this selected route, and content is never used to guess the format or remove
repeated prefixes. Provider validation is still required before configured callers
switch; synthetic checks establish neither live-provider parity nor bounded stop
time. Media remains unsupported. No application caller switches in this change,
and older configured models and endpoints are not retired.

Two further branches cover the currently configured xAI and Qwen Chat routes,
without another handler or transport. xAI accepts a selected subset of
low/medium/high/xhigh effort, nullable temperature, named and parallel local
calls, and selected JPEG/PNG user images with low, high or omitted detail.
Original reasoning is retained and replayed when present; a missing trace is
not an error. Returned refusals are retained, but refusal-bearing history fails
before transport because xAI's [request grammar](https://docs.x.ai/openapi.json)
has no documented refusal field or content part. Reported usage remains cumulative,
not additive. Latest reported cost ticks and processing tier survive later missing
values; a reported zero is retained as evidence, not proof of a free request.
Intermediate missing or `end_turn` finish values do not complete a turn: an actual
terminal finish and `[DONE]` are both required.

Qwen preserves consecutive message order and newline-joined text input. Its
selected thinking mode is disabled explicitly; authored thinking and effort
are unsupported. Preparation retains temperature below two, stopping strings
and named/parallel local calls. The current routes use `max_tokens`, whose
replacement is documented only for [newer model families](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions).
Reported reasoning is retained exactly in canonical output, but deliberately
omitted from replay: the current routes do not select the newer
[reasoning-preservation feature](https://www.alibabacloud.com/help/en/model-studio/deep-thinking).
The documented empty `function_call` placeholder is accepted, not non-null legacy
calls. Neither branch supports background work, hosted execution, uploads or
tool-result media. Pricing and credential-route selection remain runtime-owned;
no application caller has switched and neither old handler is deleted yet.

Application admission must not treat the old automatically assigned image detail as authored
intent; those production consumers have not switched.

Selected routes expose one optional `estimateInputTokens` operation when
`supportsInputTokenEstimation` is selected. Its readonly receipt contains a
nonnegative `inputTokens` count and a `coverage` value identifying what was counted:

- `kimi-messages` retains the same lowered model and messages as generation,
  including supported history and vision, but excludes top-level tool definitions.
- `google-converted-content` retains the existing system-prepended content
  conversion. It counts through `models.countTokens`, not the complete
  Interactions request or its thinking controls. The pinned Developer API
  converter rejects separate system, tools and generation configuration; the
  broader [REST request form](https://ai.google.dev/api/tokens) is not substituted.
- `anthropic-message-input` uses the generation lowering's message, system,
  thinking, output and cache configuration with the stable
  [count endpoint](https://platform.claude.com/docs/en/api/messages/count_tokens).
  Counting does not itself populate a prompt cache.
- `responses-input` uses the selected model, input, instructions and reasoning
  with the [input-token endpoint](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count).
  Both HTTP and acquired WebSocket models count over HTTP with their captured
  credentials. Counting does not send a socket frame or change continuation state.

The three new provider counts accept one foreground user message containing text,
optional system instructions, no tools, no prior history and no continuation.
Broader input fails explicitly; Kimi retains its existing wider coverage. Zero is
a valid measurement, while missing or malformed counts fail. None of these
receipts is total usage, a bill or a generation allowance. There is no automatic
preflight, retry or budget adjustment. Application admission still owns context
limits, output reduction and count-failure policy, and must supply the stable Kimi
cache identity. Configured production helpers have not switched.

Streaming Chat reads one SDK HTTP response through the native Effect SSE parser. This retains
Kimi's and xAI's required `[DONE]` terminator, which the SDK's parsed iterator suppresses;
it is not a second parser or reader over an already-decoded stream. Top-level usage is
authoritative, with Kimi's choice receipt used only when the top-level receipt is absent;
overlapping observed counts must agree. There is no reconnect, and retry hints alone
do not change control flow. The parser's size cap is explicitly disabled, so this
implementation does not claim bounded stream memory.

Chat and Responses have no separate error field on tool-result messages. Their native lowering
preserves success text unchanged and prefixes error text with `Error: `, selected
solely by the canonical result status. This is an explicit native wire decision,
not an exact reproduction of the former handler's text formatting.

Foreground Responses retains ordered `output_item.done` content rather than rebuilding it
from progress text or incomplete initial items. A sparse terminal snapshot may
omit completed items or their optional evidence, but cannot revise present
content, identity, phase or encrypted values. Function arguments compare as JSON
objects, not serialized formatting. Completed evidence remains authoritative;
terminal-only enrichment of previously absent optional evidence is rejected.
Length-limited text has an explicit outcome, while incomplete local calls never
become dispatchable. These rules implement the distinction between initial and
completed reasoning items in the [Responses streaming contract](https://developers.openai.com/api/reference/resources/responses/streaming-events).

Responses preparation records the selected temperature capability explicitly.
Unsupported temperature requests fail before transport; numeric zero remains a
value. Absent reasoning and service-tier controls inherit selected defaults,
whereas explicit null requests omission. A supplied reasoning object replaces
the whole default object; its nullable fields select individual omissions.
Selected capabilities also determine output-limit and storage support, allowed
reasoning efforts, instruction requirements and response chaining. Required
instructions are trimmed or replaced by the selected fallback during preparation,
before prefix identity is fixed; execution never rewrites an admitted request.
A null output limit means omission of the wire parameter, not an unlimited
runtime generation allowance. Unsupported authored controls and altered admitted
bindings fail before a request is sent.
All non-editor foreground protocols, including Responses WebSocket, emit observed
provider identity before progress or a
completed result. This evidence is not acceptance of recoverable background work
or confirmation of remote cancellation.

Phase events distinguish reasoning and textual-output blocks, including blocks
with no readable text. Responses output-item positions, Anthropic content-block
positions and Google step positions identify their matching boundaries and deltas;
they are not canonical-history or tool-call ordinals. Chat has no such item index:
its index is null and phases follow the first nonempty fragment and observed
transitions. Resumed background observation may begin with a delta or phase end,
without an invented start. Each sequenced background source event carries its cursor once;
terminal-only snapshots do not reconstruct live phase intervals. Runtime still
owns presentation cleanup on failed or interrupted execution.

For configured routes that support background execution, Responses exposes direct
submission, observation and cancellation operations. Submission makes one streamed
create request and returns accepted identity only after closing its local stream;
an immediately completed response instead returns its normalized result. Observation
retrieves that same response, with no replacement creation or automatic retry. Its
deadline is the original absolute admission time limit, checked before transport
and enforced with the Effect clock. Validated event sequence numbers are available
for runtime-owned checkpoints; the terminal sequence and result arrive together.
Emitting a sequence number does not itself make the checkpoint durable.
Background retrieval requires a full terminal output array. Completed items observed
on that connection must remain at their original positions with matching identities
and content; omitted optional fields retain the observed completed evidence. Missing
positions or contradictory evidence fail explicitly. Unlike foreground reconciliation,
observation does not reconstruct an unseen prefix from an entirely sparse terminal
snapshot.

Google Interactions also exposes submission, observation and cancellation when
the selected route declares background support. Background preparation requires
`store: true`. Submission sends one non-streaming create request and returns either
an accepted interaction ID or a completed canonical result. Observation polls that
same ID under the caller's original absolute deadline; it never submits another
generation request. Identity and completion carry `afterSequence: null`, since
polling supplies no provider stream cursor. No text deltas or phase intervals are
invented from snapshots. Completed snapshots use the same normalization as
foreground output, preserving reasoning signatures, original calls and observed
usage. Background observation does not create a continuation anchor from an
unavailable input history; callers retain the canonical result for replay.
This implements the selected polling route in Google's
[background execution API](https://ai.google.dev/gemini-api/docs/background-execution?hl=en).
Streaming reconnection and managed-agent execution remain unsupported.

Only a cancellation response with status `cancelled` confirms remote cancellation.
A returned terminal status is an observed outcome, without any claim about whether
it preceded the cancellation request; queued or running remains unconfirmed.
Interrupting the local HTTP request does not confirm remote cancellation.
Responses cancellation joins the complete JSON body after abort, using the same
request ownership as input counting. A distinct cleanup failure retains the known
operation and request ID; a local interruption never becomes a cancellation
acknowledgement.

Submission interrupted before an accepted result reaches the caller can leave
remote work without a delivered operation receipt. Joining the local request does
not durably admit that job. This ambiguity applies to both providers; runtime
recovery must not infer that the provider did no work or automatically resubmit.

The exported pure Responses continuation operation uses the same selected
configuration, rematerialized admitted input and completed output. It constructs
only stored anchors and checks the exact origin, effective instructions and canonical
prefix, lowers the whole history to retain tool-call context, and sends only the
appended wire items. Instructions are sent again on chained requests. Stored anchors
are limited to responses ending normally or with complete local calls; other
outcomes remain available for canonical replay. Temporary background retrieval
with `store: false` is not treated as a reusable conversation anchor. This follows
the separate [background retrieval](https://developers.openai.com/api/docs/guides/background)
and [conversation-state](https://developers.openai.com/api/docs/guides/conversation-state)
contracts.

Responses WebSocket acquisition owns one physical connection, one Node object-mode
readable and one persistent iterator. HTTP and WebSocket execution share the same
ordered response decoder and request lowering. Only one turn may execute on a
connection at a time; semantic completion ends that turn without returning the
connection's iterator. The Effect scope owns 30-second keepalive and physical
teardown. After 55 minutes, further execution requires explicit reacquisition;
there is no transparent reconnect or replacement. Interruption invalidates the
connection before joining its pending read, and only acquisition cleanup returns
the persistent iterator. These rules do not establish a bounded cleanup duration.

Prepared WebSocket turns name their acquisition and cannot run through HTTP or a
different connection. When selected chaining is supported, the live acquisition
may issue an exact-prefix local anchor for its actual latest eligible response.
A newer ineligible response, failure or connection invalidation clears that
eligibility. A pure constructor cannot manufacture local authority from a supplied
connection identifier. Stored anchors remain distinct and portable between matching
origins. The [WebSocket contract](https://developers.openai.com/api/docs/guides/websocket-mode)
describes the separate connection-local cache and implicit default lane; this
implementation adds no named lanes or multiplexing.

Buffered post-terminal frames and traffic arriving while idle invalidate the
connection. A repeated immediately preceding response identity is rejected, but
this is not universal correlation of arbitrarily delayed older traffic after a
new send. Interrupted connections are physically isolated before a new acquisition.
Binary, non-JSON and foreign-lane frames fail explicitly. Node readable flow
control provides measured backpressure without a second incoming queue; it does
not bound individual frames, completed output or total process memory.

Responses authentication is a factory-only choice between an API key and a captured
subscription access-token/account pair. The latter supplies its selected account
and fixed subscription headers to both HTTP and WebSocket requests; credentials
never rewrite the body. A nullable account does not establish stable recovery
identity. Public WebSocket requests omit `stream`, while the explicitly selected
subscription policy retains `stream: true`; foreground requests omit `background`
on both transports. Application selection must still resolve the actual backend
model, allowed effort and instruction policy before admission.

Stream ownership joins iterator cleanup. Active-read interruption aborts before
joining the iterator; successful one-read background submission closes the iterator
before aborting, so the SDK joins its pending body cancellation. Exposed cleanup
failures remain defects, with learned operation evidence retained. Error enrichment
occurs inside the owning scope, so a primary failure and a distinct exposed cleanup
failure are retained together. SDK-hidden cleanup failures are not claimed as
observable. Cleanup has no
invented timeout: an unresponsive foreign finalizer can delay completion, so these
checks do not establish a bounded stop latency.

OpenAI and Anthropic factories reject nonempty ambient custom-header settings rather
than allowing them to override the selected credential or deployment. SDK diagnostic
logging is explicitly disabled; ambient logging settings cannot expose malformed
provider data through SDK logs.

Inline media preserves its MIME string, base64 bytes (including an empty encoding),
ordered text labels and optional image detail. Video input is a static asset.
There are no file paths, uploads, inferred empty-content substitutes or size caps;
raw audio requiring additional format metadata is unsupported. Assistant media
output is not yet represented.

Anthropic Messages preserves signed and redacted reasoning, ordered local
calls and exact optional stopping/refusal evidence. Its input and tool results support
text, inline JPEG/PNG/GIF/WebP images and PDF documents. Other image MIME types,
image detail, audio, video and non-PDF documents fail explicitly. Prepared controls
cover disabled/manual/adaptive thinking, independent nullable effort, selected
temperature capability, output limit, parallel calls and supported named-tool choice,
cache lifetime and stop sequences. Thinking permits
temperature one or omission; manual thinking cannot force a named tool.
Completion follows the semantic `message_stop` event, not connection closure.
Hosted execution, beta APIs, compaction, uploads and `pause_turn` remain unsupported.

OpenRouter Chat has its own direct HTTP/SSE implementation with foreground
preparation, streaming and generation; it has no continuation, background or
token-estimate operation. Selected controls cover output limit, nullable
temperature and supported effort, stop sequences and automatic or supported
named-tool choice. It preserves grouped plain reasoning and all four typed
reasoning-detail forms, including absent, null and empty values, original local
calls, and file and URL annotations for replay. Reported billing and usage details
remain evidence rather than inferred pricing or default totals. Failure-side file
annotations retain their originating binding; runtime still owns display and reuse.

OpenRouter accepts selected PNG/JPEG/WebP/GIF images with low, high or omitted
detail, selected self-contained audio formats and inline PDF input. Text labels
remain ordered, and tool results are text-only. Video, raw audio, generated media,
unknown output forms, missing call identities and canonical orders that cannot be
represented fail explicitly. There is no retry, automatic token preflight, added
size cap or bounded-memory claim.

Responses hosted tools and sources, text annotations, log probabilities, media
inputs, uploads and compaction remain unsupported. Returned
Responses service-tier billing evidence still requires implementation.

The contract is provisional: remaining media and opaque provider values require
lossless support before it can be frozen for runtime integration or durable records.
The existing agent-creation tests exercise the package with synthetic transport.
The settings Grant action is the first application generation consumer of the
native editor implementation; configured agent and helper routes still use the
old model system. This foundation is not an independently complete migration.
