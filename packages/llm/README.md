# Native model development

This private workspace package is an unmerged development foundation for the
native model contract. Its exports point to TypeScript source; it is not a built
or published SDK artifact.

OpenAI Chat Completions implements materialized text input; the Google Interactions
implementation extends development coverage to signed reasoning, ordered local
calls and their complete tool-result groups. Preparation freezes the selected
deployment and protocol-specific controls; each execution makes one SDK request
without automatic retries. Stream completion collects the final
usage receipt when present and represents missing usage as unknown. The current
normalization retains token totals, cache-read tokens and reasoning tokens;
additional provider usage categories are not yet part of the contract.

Unsupported content fails explicitly; OpenAI does not silently discard the newly
modeled reasoning or tool exchanges. Assistant content retains its originating
model binding, and a later request requires one ordered result per local call.
Google continuation verifies an exact materialized prefix, not runtime branch or
replacement lineage; those remain runtime-owned obligations.

The contract is provisional: remaining media and opaque provider values require
lossless support before it can be frozen for runtime integration or durable records.
The existing agent-creation tests exercise the package with synthetic transport,
but no application consumer has switched away from its configured provider
routes. This foundation is not an independently complete migration.
