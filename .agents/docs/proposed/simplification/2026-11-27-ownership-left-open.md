# One owner per fact in the app and hosts: what the 2026-11-27 run left open

Date: 2026-11-27
Status: proposed
Origin: the scheduled ownership sweep on `main` at `3bc72f1`, over the app
outside `ui/`, the extension host, the desktop main process and the CLI
outside its TUI, starting from what #15229, #15250, #15253 and #15254 left
behind. The PR that adds this note lands its findings. Item 3 of
`2026-11-20-responsibility-audit-left-open.md` (the CLI's model choice) had
already landed: `cliModelCandidates`
(`packages/cli/src/runtime/models/launchDefaults.ts`) is the one list.

## Open

1. **`ApprovalGrants.limit` is a flag written as a constant.** Since Block
   went it is `Schema.optional(Schema.Literal('ask'))`
   (`packages/harness/src/shared/approvalBypassKind.ts`): present means the
   launch narrowed its run to Ask. A boolean would say so, but it is a field
   of stored rows (the run's grants), so the change takes a row version and
   buys only the name.
   Checked and kept: `LaunchApproval` (`'autoApprove' | 'ask'`) is not a
   second spelling of `ApprovalPolicy` (`'yolo' | 'ask'`). An Auto-approve
   launch turns the run's grants on and leaves its policy the project's, so
   a question or a retry past the automatic attempts still goes to a person
   (`decideApproval`, `packages/harness/src/shared/approvalPolicy.ts`, denies
   both under `yolo`); `ask` is a limit on the run's policy. The composer
   adds a third launch choice, `policy` (follow the project's,
   `packages/texra/src/shared/session/surface.ts`). Spelling the launch's
   choice `yolo` would make a launch read as a policy it does not set.
2. **`setReasoningLevel` sits with the Models tab**
   (`packages/texra/src/controllers/settingsView/modelSelection.ts`), though
   since #15250 its one caller is the window body
   (`packages/texra/src/controllers/session/openGuiWindow.ts`) and the
   terminal cannot set a level. Decide whether the CLI's picker gets the row;
   the writer then belongs beside its reader,
   `packages/harness/src/model/reasoningLevel.ts`.
