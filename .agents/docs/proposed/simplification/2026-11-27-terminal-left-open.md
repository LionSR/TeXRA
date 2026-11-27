# The terminal after the pipeline, Block and conversation-first changes: what is left open

Date: 2026-11-27
Status: proposed
Origin: the Friday terminal sweep, on `main` at `3bc72f1`, after #15229,
#15250 and #15253. The open PRs #15216, #15230, #15242, #15245 and #15247
hold `App.tsx`, `runChatTui.tsx`, `registerBuiltins.tsx`,
`statusBarDisplay.ts`, `StatusBar.tsx`, `sessionStatus.ts`,
`chatSessionController.ts`, `UserQuestion.tsx`, `ScriptStagePopup.tsx` and
`packages/cli/scripts/tui-harness.tsx`, so what follows waits on them.

The PR that adds this note fixes the seven `validate-tui` scenarios that
failed on `main` (the approval picker's Block row, the GitHub token row,
the plugin list's order), folds `ConfigForm` into its one caller, removes a
glyph and an export the document task details left, and derives the
`/approval` usage line and `--approval-policy` help from the policy list.

## Held by open PRs

1. **The design harness still offers Block.** `HARNESS_APPROVAL_USAGE` in
   `packages/cli/scripts/tui-harness.tsx` reads `[ask | never | yolo]`; the
   chat's own usage line now reads `APPROVAL_POLICIES`. The harness should
   import the chat's handler instead of restating it.
2. **A stale comment on the status bar's policy input.**
   `StatusBarChrome.approvalPolicy`
   (`packages/cli/src/chat/tui/panes/statusBarDisplay.ts`) says "a
   non-default policy earns a segment"; since Block went, the policy only
   reaches the exit hint's resume command.
3. **The status bar as a declarative table** (item 6 of
   `2026-11-24-duplication-and-complexity-scan.md`) stays open: both its
   files are held.
4. **The resume command is formatted in the TUI** (the 2026-11-26 layer
   note): moving `packages/cli/src/chat/tui/state/resumeHint.ts` under
   `runtime/` edits three held importers.
5. **"Approval policy:" against "Project approval policy:"** (the same
   note): the terminal's line is in `runChatTui.tsx`.

## Checked and left

- `configureAnsi` (item 5 of the 2026-11-24 note): still a deep module whose
  split risks the golden frames for no element saved; the 2026-11-25 scan
  reached the same verdict.
- `fullTranscriptEntryLayout` read by
  `packages/cli/src/runtime/headless/taskAttach.ts`: `texra tasks attach`
  prints scrollback exactly as the chat does, so reading the chat's layout
  is the point, not an upward leak.
- The `fileList` tool-card section in
  `packages/cli/src/chat/tui/panes/toolRenderers.tsx` is live (the Codex
  card emits it); only the transcript row of that name was deleted.
