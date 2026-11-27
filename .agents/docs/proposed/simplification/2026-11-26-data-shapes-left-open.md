# Data shapes the 2026-11-26 audit verified and did not land

Date: 2026-11-26
Status: proposed
Origin: the 2026-11-26 scheduled data-structure audit, read on `main` at
`7538e2e`. Its PR landed twelve shapes: a fact stated twice (a writable
file target's `exists`, a log entry's timestamp label, the status bar's run
id and parent flag, the compact confirm card's two hint lists), one state in
several fields (a sign-in transport's two booleans, a completion flag's
value, a Lean position answer, a native entry read), an input copied field
by field from an object the callee can take (`/status`, a child row's
metadata, the conversation page, the diagnostics tool's ports), and an
untyped record with three known cases (the history store's requests). The
findings below were checked against their producers and readers and held
back, each for the reason given.

#15229 and #15230 are still open and touch about 430 files; a finding whose
producers or readers they rewrite waits for them.

## 1. The extension's `DiffSession` copies the staged paths

`packages/extension/src/frontend/approval/VscodeDiffViewHost.ts`: the one
producer (`VscodeToolEditApprovalHost.ts`) builds
`{ original, proposed, label }` from the `ApprovalTempFiles` it also keeps,
and no method of the host reads `label` back.

Proposed: the VS Code-only methods take the two staged paths, and
`openDiff` computes its label from the request.

Held back: `toUri` takes a `DiffSource`, whose schema file is in an open
PR; take it when that lands.

## 2. `SubagentListProps` optionals its one producer always sets

`packages/cli/src/chat/tui/panes/SubagentList.tsx`: `keyboardActive`,
`maxRows`, `onCancel`, `onFocusRun` and `onKillRun` are optional, and the
one producer (`ConversationRegion.tsx`) passes all five, so eight `??` and
`?.` cover nothing.

Held back: the producer is in an open PR; making the props required under
it risks a break at merge.

## 3. The desktop logs pane's `loading` status

`LogViewerState.status` (`packages/desktop/src/renderer/logsPane.ts`) is
`'loading'` only in the initial literal, always with no entries.
`snapshot: { entries; meta } | undefined` would say so, for about the same
line count; not taken alone.

## 4. Checked and refused

- `CliGlobalArgs` (`packages/cli/src/runtime/platform/cliContext.ts`): its
  one production producer sets every field, but seven fixtures in
  `packages/cli/test/cli/CliContext.vitest.ts` pass one or two; required
  fields would add a fixture helper for six removed `=== true`.
- `readDesktopLogSnapshot`'s optional `workspaceRoot`
  (`packages/desktop/src/main/desktopAppLog.ts`): one `== null`, and its
  caller is in an open PR.
- `InitSummary.warning.model` (`packages/cli/src/commands/init.ts`) repeats
  `summary.model` with no code reader, but it is in the
  `--output-format json` output: a CLI contract change for one field.
- `OverleafRemote.isOverleaf` is derivable from `host`, with eight readers
  and no lines saved.
- `appendRow`'s `sourceResponse?: string | null`
  (`packages/harness/src/agent/runtime/loop/rows.ts`): no caller passes
  `null`, but the parameter defaults to the `null` the row stores, so
  dropping the spelling moves a coalesce and removes nothing.

## Still open from earlier notes

`2026-11-25-data-shapes-left-open.md` items 1 to 3 and 5 (each waits on a
decision or the open PRs); `RunRows.grants` and the `toolUse` log payload
(`2026-11-23-data-shapes-left-open.md`); `WorkbenchTab` as a union on
`kind` and `ExecResult.success` (`2026-11-20-data-shapes-left-open.md`);
`ToolFileAttachment`'s three payload fields
(`2026-11-18-data-shapes-left-open.md`).
