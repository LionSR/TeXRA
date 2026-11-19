# Responsibility audit: what the 2026-11-19 run left open

Date: 2026-11-19
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
run on `main` at `ceebb96`. It did two read-only surveys, one of the three
hosts against the shared app and one of the harness, app and llm against
each other. Each candidate was checked against the code, the other notes in
this directory and `.agents/docs/refuted-candidates.json`.

The PR that adds this note lands the findings with one clear owner. Each was
a fact or sentence with two or three owners whose copies had drifted:

- `hasExtension`, which moves to `pathBasics`;
- `runNoun` and `NESTED_NOUNS`, which move beside `RunIdentity`;
- the headless plan prompt, which now shows `plan.objective`;
- a clone's outcome lines, now `CLONE_COPY`;
- a subscription sign-in's prompts, now `SIGN_IN_PROMPT`;
- a plugin's trust question and declined outcome, now `PLUGINS_PAGE`.

The items below each need a decision or were judged not worth a change.

## Open

1. **Which finished run each GUI host announces.** The extension chimes
   only for a completed document task
   (`packages/extension/src/progressView/ProgressViewProvider.ts`, the
   `isDocumentTaskRun(run) && run.outcome === 'completed'` filter). The
   desktop notifies for every top-level run on any outcome
   (`packages/desktop/src/main/desktopAttention.ts`). The refuted entry
   `CLI-tui-bell-from-attention` describes one rule for both, which the
   extension's filter contradicts. A chime and an OS notification may
   differ on purpose. Decision: one rule (the attention table's) or a
   documented difference.
2. **Where a relative plugin source resolves.** The settings page
   resolves it against `roots.workspace ?? os.homedir()`
   (`packages/texra/src/controllers/settingsView/settingsPluginCommands.ts`).
   `/plugins add` uses `roots.workspace ?? cwd`
   (`packages/cli/src/chat/tui/commands/registerBuiltins.tsx`), and
   `texra plugin install` uses `cwd` alone
   (`packages/cli/src/commands/plugin.ts`). A GUI has no working directory,
   so the fallback is a host fact. Whether the terminal command should
   prefer the project root, as `/plugins add` does, is a product call.
3. **The two unsaved-changes confirmations on the desktop.** One closes a
   tab (`packages/desktop/src/renderer/discardDialog.ts`: "Discard unsaved
   changes?", Cancel / Discard). The other closes the window or switches
   project (`packages/desktop/src/main/desktopWindowHost.ts`: "There are
   unsaved editor changes.", Keep Editing / Discard Changes). They decide
   different scopes, so only the button words would be shared. That is low
   value until the desktop has a copy module of its own.
4. **`contentSimilarity.ts` holds three unrelated sections**
   (`packages/texra/src/agent/output/extraction/contentSimilarity.ts`):
   response text, Markdown fences, and similarity scoring. The fence and
   line helpers belong in a module of their own. The similarity steps
   themselves are proposed for deletion in
   `2026-11-14-llm-history-lowering-and-reply-document-recovery.md`, so
   split the file when that lands, not before.
5. **`utils/text/xmlExtraction.ts` is not general XML code.** It parses the
   output-document tag for `agent/output/` and nothing else, apart from
   `extractTextFromTag`. Move it under `agent/output/extraction/` with the
   change in item 4.
6. **`formatCliHistoryDeletionSummary` sits in app copy**
   (`packages/texra/src/ui/copy/runHistory.ts`). Its one consumer is
   `packages/cli/src/commands/history.ts`. It belongs beside the terminal's
   history labels (`packages/cli/src/runtime/historyLabels.ts`) unless a GUI
   gains a bulk delete.

## Checked and declined

- **One CLI presentation map.** `cliPresentationHost.ts` and the TUI's
  `presentInTranscript` (`packages/cli/src/chat/tui/state/subscribeApprovals.ts`)
  map the same four events. Every sentence already comes from one function
  (`shownFailureText`, `missingAgentMessage`, `formatInstructionActionHint`).
  What differs is the sink (stderr or NDJSON against a transcript row), so a
  shared map would only forward.
- **The trust button's verb.** The settings page says "Trust and enable"
  and the TUI says "Trust and switch on". This follows each surface's own
  switch vocabulary ("enable" on the page, "switch on" throughout
  `/plugins`), not drift.
- **Plugin install outcome.** "Installed X. Switch it on to review…"
  (page) and "Added X. Switch it on in /plugins…" (TUI) each name their own
  next step. The `texra plugin install` result lists the installed rows.
