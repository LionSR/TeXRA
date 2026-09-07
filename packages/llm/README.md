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
usage receipt when present and represents missing usage as unknown. The current
normalization retains token totals, cache-read tokens and reasoning tokens;
additional provider usage categories are not yet part of the contract.

Unsupported content fails explicitly; a protocol does not silently discard
reasoning or media that it cannot represent. Assistant content retains its originating
model binding, and a later request requires one ordered result per local call.
Google continuation verifies an exact materialized prefix, not runtime branch or
replacement lineage; those remain runtime-owned obligations.

Chat call arguments accumulate by the provider's call index. Original call IDs
and names cannot change; complete JSON-object arguments enter the terminal result
only after a successful tool-call finish and stream exhaustion. The normalized
assistant content places a text/refusal message before the ordered call list;
Chat history with text after a call is rejected rather than silently reordered.
The selected parallel-call setting and any required tool are frozen during
preparation. Tool definitions retain their parameters with `strict: false`.
Google also preserves a required named tool, but does not yet implement the
parallel-call control and rejects it when requested.

Chat and Responses have no separate error field on tool-result messages. Their native lowering
preserves success text unchanged and prefixes error text with `Error: `, selected
solely by the canonical result status. This is an explicit native wire decision,
not an exact reproduction of the former handler's text formatting.

Responses retains ordered `output_item.done` content rather than rebuilding it
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

Inline media preserves its MIME string, base64 bytes (including an empty encoding),
ordered text labels and optional image detail. Video input is a static asset.
There are no file paths, uploads, inferred empty-content substitutes or size caps;
raw audio requiring additional format metadata is unsupported. Assistant media
output is not yet represented.

The current Responses implementation is foreground-only. Background operations,
continuation, hosted tools and sources, text annotations, log probabilities,
media inputs, uploads, compaction and WebSocket transport remain unsupported.

The contract is provisional: remaining media and opaque provider values require
lossless support before it can be frozen for runtime integration or durable records.
The existing agent-creation tests exercise the package with synthetic transport,
but no application consumer has switched away from its configured provider
routes. This foundation is not an independently complete migration.
