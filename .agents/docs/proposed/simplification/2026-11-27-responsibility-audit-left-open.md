# Responsibility audit: what the 2026-11-27 run left open

Date: 2026-11-27
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
on `main` at `3bc72f1`. It started from the open items of the 2026-11-25
note and of the 2026-11-26 note (on the unmerged #15247), now that #15229
has merged, and two read-only comparisons: the hosts against each other and
the app, and the harness, llm and the app against what the document
pipeline's deletion left behind.

The PR that adds this note lands eight findings, one commit each: which
image types a model takes (item 3 of the 2026-11-25 note), which finished
turn each host announces (its item 5), the desktop's `openFile` request, the
status bar's second test for a top-level run, the desktop's two wordings of
the discard question, the `edited` file category, the name of the
own-run-file resolver, and the two helpers the app restated (item 7 of the
2026-11-26 note).

## Open

1. **Whether a run counts as running has two answers.** The harness's
   `isLive` (`packages/harness/src/shared/session/sessionView.ts`) excludes a
   held run idle between turns, and the rollup counts it as finished. The
   app's `runSection`
   (`packages/texra/src/shared/session/runStatusKey.ts`) files the same run
   under "Running", while its status word is "Idle". Decision: which section
   an idle conversation belongs in; then `runSection` reads `isLive`.
2. **A plan's quota meter has two app projections.** `PlanUsageSchema`
   (`packages/texra/src/shared/session/hostSnapshot.ts`) and
   `SubscriptionUsageSnapshot`
   (`packages/texra/src/shared/model/subscriptionUsage.ts`) are both built
   from one quota read. The window a meter shows is chosen twice (`fullest`
   in `packages/texra/src/ui/progress/components/PlanUsageMeters.ts`,
   `limiting` in `packages/cli/src/chat/tui/panes/statusBarDisplay.ts`), and
   only the web view hides a window past its reset. Proposed: one record and
   one "limiting window" reader in the UI copy. About 100 lines.
3. **`renderPrompt` has one variable and a caller that is not a prompt.**
   `PromptVariables`
   (`packages/harness/src/agent/prompt/templateInputs.ts`) is `{ CWD }`, and
   no prompt in the repo uses it. Its one app caller renders the TikZ
   template setting (`packages/texra/src/latex/tikzPictures.ts`), a value a
   project's config file can answer, through a template engine whose doc
   says a template is never text from a project's files. Proposed: the TikZ
   template is a plain replacement; then decide whether the dependency
   stays. `packages/harness/src/agent/prompt/agentsMd.ts` reuses
   `PromptRenderFailed` for a read failure.
4. **The "external roots" vocabulary outlived path protection.**
   `packages/harness/src/utils/files/externalRoots.ts` holds only
   `canonicalizePath`, and the prompt's "accessible external directories"
   (`packages/harness/src/agent/prompt/workspaceInfo.ts`) now lists only the
   memory folders, with a tool list every path already has. Rename both for
   what they are.
5. **The log entry's shape is written by the main process and declared
   again by the renderer** (item 3 of the 2026-11-26 note), with the level
   table in each direction. #15247 edits
   `packages/desktop/src/renderer/logsPane.ts`; do it after that merges.
6. **Showing a folder is two verbs on the desktop.** "Open run folder"
   opens the folder (`openDirectory`,
   `packages/desktop/src/main/desktopHostRequests.ts`); "Open memory folder"
   shows its parent with it selected (`revealPath`,
   `packages/desktop/src/main/desktopProjectSurface.ts`). The extension
   reveals in both. One host verb for both bodies.
7. **The desktop renderer guesses the platform** from `navigator.platform`
   (`packages/desktop/src/renderer/main.ts`) while the main process reads
   `process.platform` for the same accelerator glyphs. The preload can pass
   the main process's answer.
8. **`ToolGuard` holds one field** since path protection went
   (`packages/harness/src/tools/core/ToolTypes.ts`); six tools write
   `guard: { command }`. Flatten it, or keep it as the place a second guard
   would go.
9. **The rail's unseen mark** (`unseenRuns`,
   `packages/texra/src/shared/session/unseenRuns.ts`) still reads an outcome
   only, so a conversation that answered and waits is announced but not
   marked. Decide whether the mark follows the attention rule.
10. Items 1, 4, 5 and 6 of the 2026-11-26 note (the user's shell,
    `texra init`, the exported trace page's global, the reported model
    source) and item 1 of the 2026-11-25 note (a sign-in prompt that cannot
    be shown) are unchanged.

## Checked and declined

- **The edit classification in the turn layout**
  (`packages/texra/src/ui/progress/turnLayout.ts`) reads `toolDisplayKind`
  where the harness has `isEditLikeToolName`. The names that differ are a
  Claude Code child's, and #15230 deletes that plugin.
- **The two reasoning-level label tables** (`REASONING_LEVEL_LABELS`
  against the agent CLI settings' choices): the second is in a file #15230
  deletes.
- **The default model written in three app constants.** The setup probe and
  the launch default are allowed to differ.
- **A Google codec check against the image types llm lists.** The harness
  no longer offers a type outside the list, and the provider's own typings
  leave the set open.
