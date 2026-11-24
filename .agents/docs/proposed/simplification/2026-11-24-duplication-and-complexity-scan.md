# Duplication and complexity scan: what the 2026-11-24 audit found

Date: 2026-11-24
Status: proposed

Origin: the scheduled audit for ad-hoc or messy implementations — duplicate
logic, inconsistent patterns, overly complex functions and repeated
workarounds. Read on `main` at `dda1913`. Two read-only sweeps: a
structural duplication scan over every `packages/*/src` `.ts`/`.tsx` (1,203
files, tests excluded), and a complexity sweep for long multi-responsibility
functions. The one actionable drift this run found and fixed — the
subscription device-code fallback line decided per host — is in
[`2026-11-24-subscription-sign-in-presenters-left-open.md`](2026-11-24-subscription-sign-in-presenters-left-open.md).

## The duplication result is a verified negative

Outside the already-catalogued themes (per-host copy with one owner,
one-owner-per-fact data shapes, GitHub/timestamp/formatting helpers,
subscription sign-in, Effect context forwarding, tagged errors), there is **no
large cross-file copy-paste left**. The decisive pass extracted 2,139 brace
blocks of ≥16 normalized lines (identifiers, strings and numbers normalized
away, so renamed copies still match) and found zero cross-file pairs with
Jaccard ≥ 0.5 and ≥14 shared lines; a same-named-function-body pass across
files found zero. The daily sweeps have deduplicated the tree. No 300–600 line
consolidation exists to take.

### Patterns that look like duplication but are not (do not chase)

- Parallel switches over the transcript-row union
  (`cli/.../render/transcriptRowLines.ts`,
  `harness/.../storage/completedRunArchive.ts`,
  `harness/.../shared/transcript/transcriptRow.ts`): same union, genuinely
  different work per site, each exhaustive. Not copy-paste.
- Approval-request-kind switches across six files (the modal, the status bar,
  the queue, the headless adapter, the request metadata, the stage copy): same
  union, distinct bodies. Not copy-paste.
- GitHub pollers and event formatters already share `poller.ts` and
  `formatUtils.ts`; chat-export `latexSpec.ts`/`markdownSpec.ts` share
  `formatSpec.ts`'s `NodeRenderers` extension contract. The residual per-site
  code is the intended extension point, not duplication.
- The two `DiffViewHost` adapters (VS Code tab model vs Electron
  message-passing) are correct per-host implementations with no shared body.

## The one residual structural cluster

**Per-host tool-edit preview adapters.** `VscodeToolEditApprovalHost`
(`packages/extension/src/frontend/approval/VscodeToolEditApprovalHost.ts`) and
`desktopToolEditApproval` (`packages/desktop/src/main/desktopToolEditApproval.ts`)
each hold a `ToolEditPreview` with identical `originalPath`/`proposedPath`
getters and structurally parallel `showDiff`/`openProposed`/
`readProposedContent`/`dispose(unapplied)` (warn via `UNAPPLIED_TOOL_EDIT`,
close the diff, clean up temp files). They already share
`writeApprovalTempFiles` and `toolEditDiffLabel`. A shared abstract base with
host hooks would remove ~40–60 lines, but the host-specific bodies dominate
(VS Code stages into a fixed storage dir and reads through its tab model; the
desktop mints a per-request temp dir and reads off disk, with different
`dispose` ordering), so this is a moderate-value, moderate-risk change and the
owner's call on whether a shared base earns its abstraction. Below this run's
bar on its own.

## Complex functions worth a dedicated decomposition

Each is cohesive and well-documented but long and multi-responsibility; none
is duplication, so each is its own change, not a sweep. Listed in rough order
of density.

**Refused shape: splitting a long function into sequential single-caller
steps.** Root `AGENTS.md` bans single-caller extractions and names temporal
decomposition a red flag, and a note here is no authority over it. Cutting a
function into phases (`invokeCall` → `commitOutcome` over a hand-off record,
`stepSkills` / `stepMemory`, a `childOf` or `lowerMessages` each called
once) was tried on 2026-11-24 and reverted in review
(`LOOP-phase-split-long-functions` in
`.agents/docs/refuted-candidates.json`). What does land is the duplication
or the data shape inside the function: a fact decided in several branches
decided once, a restated value given one helper with several callers, a
table whose rows are the cases. Read items 1, 2, 5 and 6 that way.

1. `createEditorPane` (`packages/desktop/src/renderer/editorPane.ts`, ~605
   lines): one factory holds the editor surface, the file tree listing, save +
   retry, and theming over shared mutable state. Split into an editor-surface
   controller, a file-tree controller and a save controller the factory wires.
2. The `shared` command dispatcher in `openGuiWindow`
   (`packages/texra/src/controllers/session/openGuiWindow.ts`, a ~35-case
   switch inside a composition root): move the switch to a handler map and lift
   the three multi-step cases (`useCurrentFile`, `fork`, `launch`) into named
   functions, leaving the root to wire controllers.
3. **Landed 2026-11-24 (evening).** `goldenTurn`
   (`packages/cli/src/runtime/models/validationModel.ts`, ~390 lines): one
   mock-model if-chain over ~20 unrelated conformance scenarios. Each
   scenario is now its own function in `GOLDEN_SCENARIOS`, a table of
   `{ marker, play }` in the old chain's order; `goldenTurn` answers the
   harness's own requests, the parked call and the overflow refusal (moved
   in from `streamTurn`), then plays the first scenario whose marker the
   system text holds. The non-golden replies are `cannedTurn`'s early
   returns. A golden store regenerated after the change is byte-identical
   to one generated before it on the same tree.
4. `finishCall` (`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`,
   ~256 lines). The proposed split into "invoke" and "commit" helpers is
   refused (above): each would have one caller. Landed 2026-11-24 evening
   instead, inside the function: the card a call opens and the stage it
   opens under are `cardOf` / `stagedOf`, shared by the intent, the opening
   and the result row (`resultRow` restated the stage spread), and the
   result is assigned once per path, a refused check building its error
   result where it is extracted instead of overwriting `result`. The
   PreToolUse result type is named once (`ToolCallHooks`, which `toolGuard`
   picks from).
5. `configureAnsi` (`packages/cli/src/chat/tui/render/ansiMarkdown.ts`, ~285
   lines): ~10 markdown-it rule overrides share five mutable closure depth
   counters reset in two places (a leak risk on an unbalanced token stream) and
   a separate table-collapsing state machine. Thread render state through an
   explicit context and factor the table collapse into its own token pass.
6. `buildStatusBarDisplay`
   (`packages/cli/src/chat/tui/panes/statusBarDisplay.ts`, ~185 lines):
   ~20 segments pushed imperatively with repeated `{ text, color, priority,
   policy }` boilerplate. Declare segments as a `{ when, build, priority,
   policy }` data list reduced once.

## The evening run (2026-11-24): the app and the CLI

Landed item 3, and widened to the app outside `ui/` and the hosts' non-UI
code (`packages/texra/src`, `packages/cli/src` without the TUI,
`packages/desktop/src/main`, `packages/extension/src` without webviews),
ranking functions by length and by branch density. The one other chain
over cases there, Claude's per-tool input summary
(`describeToolInput` in `packages/texra/src/tools/agentCli/claudeAgentShared.ts`),
is now a map from tool name to its line. The longest remaining functions
read as deep modules or composition roots, not chains: `leanServer`'s and
`leanServerPool`'s `make`, `serviceSession`, `openDesktopWindow`,
`usageLogLayer`, `fetchAllCheckRuns`, `pollPull`,
`extractFilenameHeaderDocuments` (a line-state parser whose flags interact;
a rewrite is not provably equivalent) and `runInstallGithubAction` (a
linear script of guarded steps). The settings view's body is already a
handler table. Left for a later run: the validation model picks a scenario
two ways, environment switches (`VALIDATION_SCENARIOS`) for the echo,
fan-out and history-query replies and a system-text marker for the golden
ones; one mechanism would touch `validate-run.mjs`, the e2e fixture and
the kernel suites together.

## The scan run

Landed the one verified drift (the device-code fallback line) with a
regression test, and recorded these candidates so the theme is not re-mined.
The duplication result being a negative is the finding: there is no large
mechanical consolidation to do, and the complex-function decompositions each
need their own careful, behavior-preserving change rather than a batch.

## The evening run (2026-11-24): the harness core

Measured the longest functions in the harness core and llm (a
TypeScript-AST measure of function spans, crossed with a month's churn).
What landed is the duplication inside them, each change behavior-preserving:

- `finishCall`: item 4.
- `openStep` (`packages/harness/src/agent/runtime/loop/step.ts`): the
  contributor filter it and `resolveActivations` each wrote is one
  `contributedBy`, and the programs list it hands the description maps its
  three sources once.
- `agentCall` (`packages/harness/src/agent/runtime/delegation/AgentTool.ts`):
  whether a launch is a program's or a chat's was decided in three places
  (the program check, the file lists, the agent it runs as); one block now
  decides the child once, and the four file lists are one `ChildFiles` type.
- `invocationBody` (`packages/llm/src/api/anthropicMessages.ts`): the
  thinking parameter is one expression instead of a `let` assigned down a
  ladder.

Tried and reverted in review: phase splits of `finishCall`, `openStep`
(`stepSkills`, `stepMemory`, `changeWarnings`), `agentCall` (`childOf`) and
`invocationBody` (`lowerMessages`) into single-caller steps; see the refused
shape above. Measured and left: `modelInvokerLayer` and
`openaiResponsesModel` are factories whose length is their inner functions,
each already named; `runToolUse` already reads as `runTurn` and `loopBody`;
`toolCatalogLayer`'s native-revision read (`readWith`) sits on the
plugin-trust path; `scriptDoor` is one ordering protocol over shared state.
