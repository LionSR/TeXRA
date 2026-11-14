# Tool card, tool result and child delivery: three shapes left half-done

Date: 2026-11-14
Status: proposed
Origin: the 2026-11-14 scheduled data-structure audit, findings 1 to 3,
re-verified on `main` at `4b8f417`. Each was larger than the audit's one-line
description once its producers and readers were traced. This note records what
the trace found, the step that landed with it, and what is left.

## 1. `ToolUseLog`: the nested fallback is a stored tool result

Audit claim: one builder writes `summary`, `error` and `userInstruction`
either at the top level or inside `output`, so `normalizeToolUse`
(`packages/harness/src/shared/toolUse.ts`) reads both.

What the code does: there are two producers, and they write different shapes
on purpose.

- An agent-CLI child (`packages/texra/src/tools/agentCli/`) stores its own
  `tool.end` rows with the three fields at the top level.
- A run with a run history stores no card row. `callCard`
  (`packages/harness/src/controllers/session/rowReader.ts`) shows the call's
  `tool.result` as a `tool.end` whose `output` is the stored result without its
  `status`. That is the "nested" case.

`output` being the whole result is read back as such in two places:
`toolResultNodes` (`packages/harness/src/transcript/completedRunArchive.ts`)
decodes it with `ToolResultSchema` to rebuild the text the model read, and
`statusOf` (`packages/harness/src/shared/transcript/scriptStage.ts`) reads
`reusedFrom` and `name` from it. Lifting the three fields out of `output`
breaks the export's decode (an error result needs its `error`); copying them
to the top level states each twice and changes the export of a failed call
that carries user feedback (`tool.error` is returned before the decode).

Landed: `toolName` is required (every producer already wrote it).

Left: give the card the result as a typed field. `tool.end` would carry
`result: SettledToolResult` for a call with a run history and the flat fields
only for an agent-CLI card; the export and the script stage read `result`
without decoding `output`, and `normalizeToolUse` loses `firstTrimmed` and
`extractOutputContent`. `tool.end` is stored for agent-CLI children, so the
change bumps its row version.

## 2. `ExecutedToolResult`: commit instructions on the result

Audit claim: `facts` and `consumedFollowUps` are never stored, so
`SettledToolResultSchema` exists partly to strip them; return them beside the
result.

What the code does: a tool's `execute` returns `ToolResult | string`
(`packages/harness/src/tools/core/definition.ts`), the published plugin
contract; 48 source files name `ToolResult` and eight tool sites state
`facts`. Returning the instructions beside the result changes that contract
for every tool, or adds a second return shape next to the first.

Landed: the stored fields are their own struct in
`packages/harness/src/shared/schemas/toolResult.ts` and the tool's result
extends it with `files`, `consumedFollowUps` and `facts`, so the stored schema
is no longer derived by omitting them. The stored shape is unchanged.

Left, in order:

1. Decide the tool-facing shape. Two candidates: `execute` returns
   `{ result, facts?, consumedFollowUps? }` (one shape, every tool edited), or
   the call states them through its `ToolContext` and dispatch reads them when
   it commits (no return change, but a collector the call writes to, which
   `packages/harness/AGENTS.md` "Event channels and cards" argues against).
2. With the fields off the result, `extractToolAttachments`
   (`packages/harness/src/agent/core/tools/toolAttachmentExtraction.ts`) only
   strips bytes.
3. The `Schema.optional(Schema.Undefined)` placeholders (`error` on the
   executed branch; `output`, `edits`, `files` on the error branch) let readers
   skip narrowing on `status`. Removing them is a separate sweep of those
   readers and does not depend on the steps above.

## 3. `ChildRunDelivery`: a union on family and outcome

Audit claim: one struct with ten optional fields for four kinds of report;
make it a union.

What the code does:

- `family` is open: a plugin names its own (`codex`, `claude`), so the harness
  cannot enumerate the cases. A union needs the three harness families
  (`subagent`, `background`, `script`) plus one generic case for a plugin's.
- `attributes` is ordered and open because `formatDelivery`
  (`packages/harness/src/agent/runtime/deliveryEnvelope.ts`) renders them in
  order into the envelope the parent's model reads. Typing them per case moves
  the attribute order into the renderer; the envelope text must not change.
- `echoedDelivery` (`packages/harness/src/shared/subagentFollowup.ts`) builds
  the same struct from an envelope a model echoes as text, where only the tag
  and attributes are known. It would build the generic case, or
  `deliverySummary` would take a narrower input than the stored type.
- The delivery is stored on `followup.queued` (version 6) and exported from
  `@texra-ai/harness/plugins`, so the change is a row version bump and a
  plugin-contract change.

Landed: nothing. No step separates from the stored shape, and the version
bump is the owner's decision.

Proposed shape, for that decision:

```ts
type ChildRunDelivery =
  | { family: 'background'; outcome: 'exited'; call; exit; wallTime; lines }
  | { family: 'background'; outcome: 'failed'; call; message }
  | { family: 'script'; outcome: 'completed' | 'failed' | 'stopped'; summary; response?; message? }
  | { family: 'subagent'; outcome: 'completed'; agent; output; ... }
  | { family: 'subagent'; outcome: 'failed'; agent; message; ... }
  | { family: string; outcome: 'completed' | 'failed'; attributes; ... }; // a plugin's
```

`outcome` replaces "carries `message`" as what makes a report an error, which
`formatDelivery` and `deliverySummary` each test today. Whether the generic
case is worth keeping beside the three typed ones, or the typed ones are a
second spelling of it, is the comparison to make first: if a plugin's case
must stay generic, typing only the harness's three leaves two designs in one
schema.
