# One owner per fact in the app and hosts: what the 2026-11-27 run left open

Date: 2026-11-27
Status: proposed
Origin: the scheduled ownership sweep on `main` at `3bc72f1`, over the app
outside `ui/`, the extension host, the desktop main process and the CLI
outside its TUI, starting from what #15229, #15250, #15253 and #15254 left
behind. The PR that adds this note lands five findings. Item 3 of
`2026-11-20-responsibility-audit-left-open.md` (the CLI's model choice) had
already landed: `cliModelCandidates`
(`packages/cli/src/runtime/models/launchDefaults.ts`) is the one list.

## Open

1. **After Block, a launch's approval is spelled two ways.**
   `LaunchApproval` (`'autoApprove' | 'ask'`,
   `packages/harness/src/shared/approvalBypassKind.ts`) and `ApprovalPolicy`
   (`'yolo' | 'ask'`) name the same two choices; the CLI's `launchApproval`
   (`packages/cli/src/runtime/platform/cliContext.ts`) translates for every
   launch, and `ApprovalGrants.limit` is `Schema.Literal('ask')`, a flag
   written as a constant. Both are persisted or wire shapes, so the change
   takes a row version and the owner's word.
2. **Command titles restated in the extension.** The walkthrough's
   "Create Sample Project" button (`packages/extension/src/extension.ts`) and
   the clone prompt's title (`packages/extension/src/commands/git/gitCommands.ts`)
   restate `COMMAND_CATALOG` titles
   (`packages/texra/src/shared/commands/catalog.ts`). A typed
   `commandTitle(id)` beside the catalog would also replace the lookup in
   `desktopCommandEntry` (`packages/desktop/src/shared/desktopCommandSurface.ts`).
3. **"Task not found" three ways in the CLI.** `resumeRun.ts` and the chat's
   `/resume` (`chatSessionController.ts`) say `Task not found: <id>`;
   `formatCliHistoryNotFoundText` (`packages/cli/src/runtime/history.ts`)
   adds that history is scoped by `--cwd`, as a resume is too. One wording
   changes what `texra resume` prints.
4. **`setReasoningLevel` sits with the Models tab**
   (`packages/texra/src/controllers/settingsView/modelSelection.ts`), though
   since #15250 its one caller is the window body
   (`packages/texra/src/controllers/session/openGuiWindow.ts`) and the
   terminal cannot set a level. Decide whether the CLI's picker gets the row;
   the writer then belongs beside its reader,
   `packages/harness/src/model/reasoningLevel.ts`.
