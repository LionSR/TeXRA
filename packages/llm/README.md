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
deployment and protocol-specific controls; each execution makes one SDK request
without automatic retries. Stream completion collects the final
usage receipt when present and represents missing usage as unknown. Common usage
retains token totals, cache-read tokens and reasoning tokens; Anthropic also retains
its cache-creation breakdown and returned tier and geography. Further provider
usage categories remain incomplete, and pricing remains runtime-owned.

Unsupported content fails explicitly; a protocol does not silently discard
reasoning or media that it cannot represent. Assistant content retains its originating
model binding, and a later request requires one ordered result per local call.
Google and Responses continuation verify an exact materialized prefix, not runtime
branch or replacement lineage; those remain runtime-owned obligations.

Chat call arguments accumulate by the provider's call index. Original call IDs
and names cannot change; complete JSON-object arguments enter the terminal result
only after a successful tool-call finish and stream exhaustion. The normalized
assistant content places a text/refusal message before the ordered call list;
Chat history with text after a call is rejected rather than silently reordered.
Plain OpenAI Chat freezes the selected parallel-call setting and any required tool
during preparation. Tool definitions retain their parameters with `strict: false`.
Google also preserves a required named tool, but does not yet implement the
parallel-call control and rejects it when requested.

The same direct Chat implementation has explicit DeepSeek, Kimi and GLM protocol
branches. They preserve exact `reasoning_content` once in canonical reasoning and
replay it on retained assistant turns. Selected capabilities determine thinking,
effort, fixed or omitted temperature, reasoning retention and named-tool support;
there is no model-name inference or effort clamping. GLM accepts automatic tool
selection only, and all three reject the authored parallel-call control. Their
current scope is text and ordinary local tools, without media, hosted execution,
background, storage, caching, stopping or geography controls. MiniMax remains
unsupported pending its authoritative stream contract. Complete Kimi Code Plan
admission also requires a caller-supplied `prompt_cache_key`; its runtime identity
binding has not been implemented or replaced with an invented session identity.

Chat reads one SDK HTTP response through the native Effect SSE parser. This retains
Kimi's required `[DONE]` terminator, which the SDK's parsed iterator suppresses;
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
All foreground protocols emit observed provider identity before progress or a
completed result. This evidence is not acceptance of recoverable background work
or confirmation of remote cancellation.

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

Only a cancellation response with status `cancelled` confirms remote cancellation.
A returned terminal status is an observed outcome, without any claim about whether
it preceded the cancellation request; queued or running remains unconfirmed.
Interrupting the local HTTP request does not confirm remote cancellation.

Responses continuation is a pure operation over rematerialized admitted input and
completed output. It checks the exact origin, effective instructions and canonical
prefix, lowers the whole history to retain tool-call context, and sends only the
appended wire items. Instructions are sent again on chained requests. Anchors are
currently limited to stored responses ending normally or with complete local calls;
other outcomes remain available for canonical replay. Temporary background retrieval
with `store: false` is not treated as a reusable conversation anchor. This follows
the separate [background retrieval](https://developers.openai.com/api/docs/guides/background)
and [conversation-state](https://developers.openai.com/api/docs/guides/conversation-state)
contracts.

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
cache lifetime, stop sequences, service tier and geography. Thinking permits
temperature one or omission; manual thinking cannot force a named tool.
Completion follows the semantic `message_stop` event, not connection closure.
Hosted execution, beta APIs, compaction, uploads and `pause_turn` remain unsupported.

Responses hosted tools and sources, text annotations, log probabilities, media
inputs, uploads, compaction and WebSocket transport remain unsupported. Complete
phase-boundary progress, including reasoning phases with no text, and returned
Responses service-tier billing evidence still require implementation.

The contract is provisional: remaining media and opaque provider values require
lossless support before it can be frozen for runtime integration or durable records.
The existing agent-creation tests exercise the package with synthetic transport,
but no application consumer has switched away from its configured provider
routes. This foundation is not an independently complete migration.
