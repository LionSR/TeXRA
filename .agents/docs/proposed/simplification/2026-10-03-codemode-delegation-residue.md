# Code mode and delegation: residue the `delegate_*` deletion left

Date: 2026-10-03
Status: proposed
Origin: simplification sweep over the code-mode lanes (#13616–#13627) and
the fixes that followed them. The same PR made these behaviour-preserving
deletions directly: the dead `requireVisibleAgent`, the `prepare` thunk on
`executeSubagentInBand`, the single-file `determinismPrelude.ts`, and the four
`ScriptTally` counts that no writer sets. The candidates below change a
persisted shape, model-facing copy, or a file under `src/agent/runtime/loop/`.
Each of those needs a decision or a free lane, so none was made as a drive-by
edit.

## 1. Delegation targets are still keyed by "the tools that launch a category"

`readDelegationTargets` (`src/tools/delegation/delegationAvailability.ts`)
collects, per agent category, "the offered delegation tools that launch it".
That shape was built for `delegate_workflow`/`delegate_agent`, when each tool
launched one category. Today there is one launcher:

- `ToolDefinition.availabilityCategory` (`src/shared/schemas/toolDefinition.ts`)
  has one declarer in production: `agent` (`AgentTool.ts`, which declares
  both categories). `readDelegationTargets` also filters on
  `name === AGENT_TOOL_NAME`, so the field and the name check say the same
  thing.
- `DelegationTargets.agents[].tools` (`src/shared/schemas/offeredTools.ts`) is
  always `['agent']`. Its only reader is the copy in `delegationSection` and
  `delegationUpdate` ("Available agents for agent:", "Agents for agent now
  available: …").

**Proposal:** delete `availabilityCategory`. `readDelegationTargets` then
lists both categories whenever `agent` is offered, and `tools` leaves
`DelegationTargets`. Model-facing copy reads "Available workflow agents:" and
"Available tool-use agents:".

**What we give up:** nothing at runtime. The system text changes, so a
cached prefix for an open run is invalidated once. `RunContext.delegation`
is persisted in `tools.offered` rows as a strict object, so this is a format
change. That is free before 1.0, but it must go with the storage-freeze
work, not land as a drive-by.

**Elements:** -1 schema field on `ToolDefinition`, -1 field on
`DelegationTargets`, -1 `defineTool` passthrough
(`src/tools/core/definition.ts`), and the `launchers` map.

## 2. `backgroundScript.tool` always names `script`

`launchBackgroundScript` (`src/tools/codemode/backgroundScript.ts`) takes a
`tool` parameter. Its one caller passes `SCRIPT_TOOL`, so
`AgentConfig.backgroundScript.tool` is always `'script'`. The golden fixture
(`golden-1.0.sql`) carries the same constant. The run loop
(`src/agent/runtime/loop/toolUse.ts`) opens a background script's run on that
field.

**Proposal:** drop `tool` from `backgroundScript`, and have the loop open
the run on the `script` tool. Do this after #13663 (durability fixes in
`loop/`) merges. It is a persisted-config change, and the golden fixture
moves with it.

## 3. `runMode: 'single-cycle'` and `resultOnly` are one fact

`NativeSubagentStrategyBase` (`src/agent/runtime/nativeSubagentStrategy.ts`)
has two optional fields. Their only setter is the in-band launch
(`inBandSubagentRun.ts`), which sets both together. No test sets either.
Folding them into one `inBand: true` deletes a field and two of the four
branch sites. The module sits outside this sweep's file list, so it was left
unedited.

## 4. `launchDetachedSubagent` takes the parent run id twice

`launchDetachedSubagent` (`src/tools/delegation/subagentRun.ts`) receives
`parent: RunToolCall`, and also `launch.parentRunId`. The one production
caller (`AgentTool.ts`) passes `call.run.runId`, so the second carrier is
redundant. Two suites (`SubagentRunChildRunId.vitest.ts`,
`NativeSubagentProductionPath.vitest.ts`) pass a `parentRunId` that differs
from their fixture's `run.runId` and assert on it. Dropping the parameter
means rewriting those fixtures, which is why it was not done here.

## 5. Stale "workflow sandbox" wording

`src/tools/structuredOutput.ts` still documents `assertSafeSandboxSchema` as
guarding "a JSON Schema authored inside a workflow sandbox". That sandbox is
gone. Today the guard covers the model-authored `schema` argument of `agent`.
The guard stays; only the comment is out of date.

## Acceptance

- Items 1 and 2 land with the storage-format work and bump the format in
  the same PR. Each deletes its field from schema, writer, reader and golden
  fixture together.
- Item 3 is net-negative in elements, with no test changes.
- Item 4 rewrites the two fixtures, so the call carries the parent once.
