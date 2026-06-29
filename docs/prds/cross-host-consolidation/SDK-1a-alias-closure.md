---
created: 2026-06-29
---

# SDK-1a: Alias-Closure - The `@texra/core` No-Leak Gate

The first executable step of the agent-SDK boundary
(`docs/prds/2026-06-29-prd-agent-sdk-boundary.md`), and its #1-ranked risk: the
regex boundary lint (`scripts/check-runtime-boundaries.mjs`) is green while the
type surface leaks, because it cannot see `export type RuntimeTaskState = TaskState`
re-exporting an internal type through an allowed path. Until this closes, freezing
the published Tier surface is a fiction.

This sub-PRD ships in two halves: the **gate** (landed) and the **conversions**
(the implementation PR). The gate is the oracle for the conversions.

## The gate (landed): `scripts/check-alias-leaks.mjs`

A sibling to `check-runtime-boundaries.mjs`, grounded in the TypeScript compiler API
(no new dependency; `ts-morph` deliberately not added). Two detectors, **decided by
symbol identity, not name** (so the flow-local `AgentCategory` is distinguished from
the published one), piercing type operators (`Parameters<typeof loadAgents>[0]` ->
internal `LoadAgentsOptions` is caught, not just bare `= TaskState`):

- **Detector A - ALIAS-LEAK:** every `export type Runtime* = <RHS>` (and
  `export { Y as Runtime* }`) in `src/agent/runtime/*` whose RHS transitively
  references a named type **not** re-exported from the barrel
  (`packages/core/src/index.ts`). A re-alias of a *published* type (`= AgentConfig`)
  is **not** flagged - convenience re-exports are style, not encapsulation breaks.
- **Detector B - SIGNATURE-LEAK:** every published barrel type whose member or
  call-signature parameter is typed by an internal (hidden-zone) named type. Seeded
  with the two RE-TYPE targets so they fail until fixed; an `ALLOWLIST` admits
  audited benign projections, each with a justification.

The four GS delete-wholesale shim modules (`runCoordinatorCommands`,
`executionQueries`, `streamControl`, `modelSwitch`) are skip-listed: their aliasing
exports die with the module in GS-3, so converting them now is wasted work. Remove a
skip entry as GS-3 deletes that module, so a regression can never reintroduce it.

Run: `npm run check:alias-leaks` (exit 1 today; 29 leak-lines across ~22 exports +
the 3 signature leaks). **Not yet wired into CI** - it goes into `ci.yml` as the
final commit of the conversions half, when it is green.

## The reconciled disposition (the conversions: the work-list)

Of **110** runtime-prefixed exports (109 types + 1 value const), the SDK study's
"25 of 45 alias-style exports are genuine internal leaks" is **confirmed exactly**:
3 DELETE-WHOLESALE / 20 CONVERT / 2 RE-TYPE. Full split:

| Disposition | Count | What it means |
| --- | --- | --- |
| DELETE-WHOLESALE | 17 | lives in a GS-3 shim module; dies with it - **not SDK-1a's work** |
| CONVERT | 27 | the SDK-1a conversions (below) |
| KEEP | 66 | genuine projections / result unions / host-port interfaces |
| RE-TYPE | 2 | `onBeforeWaiting`, `AgentRunHandle` (non-`Runtime*`, published) |

The live work-list is the lint output itself (`npm run check:alias-leaks`); drive it
to zero. The conversions fall into four patterns, with the adversary's caveats:

- **Inline + unexport** (internal `Y`, zero external consumers): `RuntimeAgentSource`,
  `RuntimeLocalAgentSource`, `RuntimeAgentDirectories`, `RuntimeHistoryWorkspaceFile`,
  `RuntimeSessionResumeData`. Delete the exported alias; intra-module callers use `Y`.
- **Inline the published name** (`Y` is on the barrel - hygiene, the lint does not
  even flag these): `RuntimeAgentConfig` -> `AgentConfig` (keeps `config.agent`
  **raw**), `RuntimeAgentConfigPayload`, `RuntimeExecutionRequest`,
  `RuntimeValidatedExecutionRequest`, `RuntimeExecutionValidationResult`,
  `RuntimeAgentEntry`. **`RuntimeHistoryAgentConfig` is KEEP** (its `Y` = `AgentConfig`
  is published; the adversary flipped it off the CONVERT list - the lint must not
  flag it).
- **Publish the target, then inline** (internal but genuinely needed on the surface):
  `RuntimeTaskState`/`WorkflowTaskState`/`ToolUseTaskState` (publish `TaskState*`,
  agentConfig-bearing - inline, not `Pick`), `RuntimeAgentOptionsData` (publish the
  full `AgentOptionsDataPayload` - consumer reads both fields, no honest narrowing),
  `RuntimeAgentLoadOptions` (publish `LoadAgentsOptions`).
- **Author a value-only projection / re-type** (inline INVALID - the boundary lint
  bans the host import, or it carries a flow-internal): the `RuntimeToolEditApproval*`
  trio (author `{path,originalContent,proposedContent,sourceTool,streamId}` in
  `approvalCommands.ts` - `@tools/approval` is host-banned), `RuntimeHistoryExecutionMeta`
  (`Pick<ExecutionMeta, ...>` - `@agent/storage` banned), `RuntimeHistoryResultMeta`
  (opaque-by-`JSON.stringify`), `RuntimeAgentCreator{Category,Config,UI}` (target the
  published `AgentCategory` SSOT; the UI callback is the Area-3 `onBeforeWaiting`),
  `RuntimeExternalInquiryResolution` (value-only local shape). `RuntimeToolUseSessionSnapshot`
  -> an opaque branded token typed **symmetrically** at produce (`:38`) and consume
  (`:82`) or it compile-breaks.
- **The 2 RE-TYPEs:** `RunAgentOptions.onBeforeWaiting` (+ `ExecuteAgentOptions`) ->
  `(interimText?, touchedFiles?) => boolean | void | Promise<...>`, `runAgent` adapts;
  `AgentRunHandle` -> a real interface dropping `runtimeHost` (SDK correction #4).

## Sequencing within SDK-1a

1. **The gate** (this commit): the lint rule + the `check:alias-leaks` script entry +
   this spec. CI wiring deferred.
2. **The conversions** (the implementation PR, in a worktree): drive
   `check:alias-leaks` to zero following the patterns above, then add it to `ci.yml`
   next to `check:runtime-boundaries`. Land the `RuntimeToolEditApproval*` trio and
   the `RuntimeAgentCreatorRunRequest` members atomically (a member of a KEEP type is
   one of the leaky aliases - never leave it transiently leaky). The
   `RuntimeToolUseSessionSnapshot` produce/consume sites change in lockstep.

DELETE-WHOLESALE is **not** done here - those 17 exports vanish with their modules in
GS-3. When GS-3 lands, the boundary-lint guidance strings at
`check-runtime-boundaries.mjs:278/284/302/309/485/490/495/566/570` (which name the
doomed module paths as the redirect target) must be re-pointed in the same commit, or
the gate starts advertising deleted modules.

## Acceptance

- `npm run check:alias-leaks` exits 0; it is wired into `ci.yml`.
- No published barrel type names a hidden-zone internal (Detector B clean; the
  `ALLOWLIST` is empty or every entry carries a justification).
- `config.agent` stays raw through every inline (the resume-id contract, sub-PRD 04).
- Typecheck is green across all four workspace projects after the conversions.
