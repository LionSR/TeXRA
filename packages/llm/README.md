# Native model development

This private workspace package is an unmerged development foundation for the
native model contract. Its exports point to TypeScript source; it is not a built
or published SDK artifact.

The implemented protocol is OpenAI Chat Completions with materialized text input.
Preparation freezes the selected deployment and controls; each execution makes
one SDK request without automatic retries. Stream completion collects the final
usage receipt when present and represents missing usage as unknown. The current
normalization retains token totals, cache-read tokens and reasoning tokens;
additional provider usage categories are not yet part of the contract.

Unsupported content fails explicitly. The text-only contract is provisional:
tool calls, media, reasoning and opaque provider values require lossless support
before this contract can be frozen for runtime integration or durable records.
The existing agent-creation tests exercise the package with synthetic transport,
but no application consumer has switched away from its configured provider
routes. This foundation is not an independently complete migration.
