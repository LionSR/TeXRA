# Data shapes the 2026-11-23 audit verified and did not land

Date: 2026-11-23
Status: proposed
Origin: the 2026-11-23 scheduled data-structure audit, read on `main` at
`6b29e26`. Its PR landed nine shapes: a state spelled as several fields (the
desktop terminal's shell, a request's decision and its `seq`, the history
query's fed and unreadable runs), a fact stored twice (the run listing's
model, an edit preview's paths, the tool card's second flat copy), and
optional fields their one producer always sets (the CLI status bar's inputs,
the Models-tab row's flags, the CLI's stored output targets), plus the
provider control's link, whose two optionals hid two links. The findings
below were checked against their producers and readers and held back, each
for the reason given, in the order worth taking.

## 1. The `toolUse` log payload has no producer outside the design harnesses

`MESSAGE_TYPES.TOOL_USE` (`packages/harness/src/shared/schemas/log.ts`) is
decoded by `LogPayload` and turned into a tool row by
`packages/harness/src/shared/session/transcriptLogRows.ts`, but no source
writes a `log` row of that type: a card is its call's rows, or an agent-CLI
child's `tool.start` and `tool.end`. The writers are
`packages/cli/scripts/tui-harness.tsx` and
`packages/desktop/design-harness/scenes/desktop.ts`. It is the one producer
of a `ToolCallLog` without a `status`, so `ToolCallLog.status` and
`ToolRowModel.status` stay optional and four readers handle a status that a
real card always has (`toolRowLook` in
`packages/texra/src/ui/copy/runStatus.ts`, the `default:` of `statusOf` in
`packages/harness/src/shared/transcript/scriptStage.ts`).

Proposed: delete the payload kind and its row case, seed the two harnesses
with `tool.start` and `tool.end` rows, and make both statuses required.

Held back: the harness scenes are many, and whether an installed plugin may
log a `toolUse` payload through `AgentTrace` needs checking first.

## 2. `ScriptCallCard` is a status beside fields valid in one status

`packages/harness/src/agent/runtime/scriptRun.ts`: `error` belongs to a
failed or skipped call, `reusedFrom` and `value` to a completed one; the
producer fills the others with `null`, and `scriptCallsView.ts`
(`packages/harness/src/tools/executions/`) spreads each when it is not null.

Proposed: keep the call's latest `ToolResultPayload | undefined` on the card
and let the three readers narrow it; `status` stays as the derived word.

Held back for size only: four sites, internal.

## 3. A spend cap's "none" travels as `number | null | undefined`

`maxCostUsd?: number | null` is the tool input's spelling
(`packages/harness/src/agent/runtime/delegation/inputFields.ts`), passed
unchanged through `AgentTool.ts`, `subagentRun.ts`, `childLaunch.ts` and
`RegisterRunOptions` (`packages/harness/src/shared/session/runFacts.ts`) until
`packages/harness/src/agent/storage/runLifecycle.ts` writes `?? null`.

Proposed: `number | null` from where the input is decoded. About eight
sites; removes one coalesce.

## 4. `RunRows.grants` is null only while `start` is

`packages/harness/src/shared/session/runRowsShape.ts`. Three readers coalesce
it (`approvalBypassKind.ts`, `sessionViewUpdate.ts`, `runApprovalQueue.ts`).
A `RunRows` without a `start` is a real state (a follow-up queued first), and
`approval.policy` writes `grants` without checking `start`; nothing read
produces that row before a start, but that was not proved. Take it with a
`started: { start; grants } | null` grouping, not alone.

## 5. `ToolPluginSetup` states install actions as five optional fields

`packages/texra/src/tools/registry.ts`: `installGuide`, `installUrl`,
`installExtensionId`, `installCommand` and `authCommand` are rebuilt into the
wire's `ToolInstallAction` union by five conditional spreads in
`packages/texra/src/controllers/settingsView/ToolDashboardData.ts`, which
reads the two commands a second time for the terminal action.

Proposed: `setup.actions: readonly ToolInstallAction[]`, declared by each of
the six plugins.

Held back: the Codex and Claude plugins declare `installCommand` as a getter
so their probe stays deferred; an array literal would evaluate it when the
plugin loads. Needs a lazy `actions` first.

## 6. Smaller

- `ModelSelectionItem`
  (`packages/texra/src/shared/settingsView/settingsViewMessages.ts`) copies
  `ModelOptionData` field by field, renaming `context`, from two arrays its
  producer pairs by index (`modelSelection.ts`,
  `packages/texra/src/controllers/settingsView/`). Carry the option, or
  spread its fields.
- `DesktopProject.key` (`packages/desktop/src/main/desktopProjects.ts`)
  repeats `display.key` and `roots.storage`; about eighteen readers, no logic
  removed.
- `LatexToolchainProbe.installed`
  (`packages/texra/src/latex/latexToolchain.ts`) is derivable from `tools`,
  but two of its five callers read the set, so dropping it moves the
  derivation to both. Not worth it.

## Still open from earlier notes

`WorkbenchTab` as a union on `kind` with a typed pane table,
`CompactionActivityBlock.finalized` and `freed`, the CLI history delete
result's `found` (`2026-11-20-data-shapes-left-open.md`);
`ToolFileAttachment`'s three payload fields, which needs a decision on the
plugin surface (`2026-11-18-data-shapes-left-open.md`); the LaTeX settings
status keyed by tool beside `installed` keyed by dependency, which needs
three display rules decided (`2026-11-15-data-shapes-left-after-the-audit.md`).
