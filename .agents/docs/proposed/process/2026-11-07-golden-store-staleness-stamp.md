# Golden store staleness: stamp the prompt inputs, compare in a pure test

Date: 2026-11-07
Status: proposed
Origin: R3-R (#14823, #14826). Main's `golden-1.0.sql` went stale twice in one
day, through #14805's system prompt and #14816's `document_propose`
description, and no check saw either.

## Proposal

The golden store drifts unnoticed when what the model is sent changes: the
system-prompt sections, the tool definitions and the agents' prompts. These
sit in its `context.blob` rows and in the digests that name them. So
`generate-golden-store.mjs`, which already bundles production code
(`rowCodec`), would stamp into the dump one `sha256`, as a comment line or a
one-row table no reader opens. It would hash the canonical JSON of three
inputs: every tool definition as `toolSchema.ts` renders it from the harness
and TeXRA plugin tables, the system-prompt sections before date, platform
and path substitution, and the fixture and bundled agents the scenario
names. A `pure` suite would recompute the hash with the same exported
function and fail with "regenerate: `pnpm --filter @texra-ai/cli run
golden:store`" on a mismatch. It needs no CLI and no spawn, and takes
milliseconds. It costs a false positive, one regeneration, when a tool or
prompt the golden runs never see changes. It still misses behavioural drift,
such as #14807's recipe no longer returning documents, which stays the
generator's job.
