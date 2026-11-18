# LaTeX source facts with two owners, and copy the CLI restates

Date: 2026-11-18
Status: proposed (five findings landed with this note; the rest are open)
Origin: the 2026-11-18 scheduled responsibility audit on `main` at
`a90f320`. Two read-only surveys (the LaTeX, housekeeping, replacement and
output modules; the terminal client against `@ui/copy` and the transcript
helpers), each finding checked against the code and against
`.agents/docs/refuted-candidates.json`.

## Landed with this note

1. **What a fixer is told about a latexdiff artifact.** VS Code's "Fix
   compilation" command and the compile check's fixer each detected the
   artifact, applied the "plain `_diff` counts only when its source exists"
   rule and wrote the repair sentences; with the source missing, the command
   still said "fix the source too". `latexdiffArtifactSource` and
   `latexdiffArtifactNote` in
   `packages/texra/src/latex/latexdiff/diffFileNameManager.ts`.
2. **Reading a LaTeX file's uncommented text.** Figures, dependencies and
   bibliography each read, mapped the error and stripped comments, and the
   TikZ extractor skipped the strip, so a commented-out figure was compiled.
   `readUncommentedLatex` and `LATEX_PROBE_CONCURRENCY` in
   `packages/texra/src/latex/latexParsingUtils.ts`.
3. **A missing `.bib` path.** `extract_bib_entries` rebuilt
   `workspaceRelativePath` with `toPosixPath`, which drops a leading slash.
4. **An output's display name.** The compile check restated
   `outputDisplayName` (`packages/texra/src/shared/plugins/documentOutputs.ts`)
   without the lineage document.
5. **The build folder.** `LATEX_BUILD_DIRECTORY`
   (`packages/texra/src/common/files/fileHandlingRules.ts`) and
   `perInputBuildDirectory` (`packages/texra/src/latex/texTools.ts`).
6. **Nine symbols with an entity row and no glyph row** join
   `MATH_SYMBOL_SPELLINGS`; this closes app fact 1 of
   `2026-11-15-host-rules-and-app-facts-with-two-owners.md`.

## Open: LaTeX

1. **The latexdiff blank-line fix runs in two categories.**
   `LATEXDIFF_REPLACEMENTS` (`packages/texra/src/replacement/rules.ts`) and
   the first rule of `LATEXDIFF_MARKUP_REPLACEMENTS`
   (`packages/texra/src/replacement/rulesRegex.ts`) both collapse the blank
   line before `}\end{align*}%DIFAUXCMD`; the regex is a superset. Deleting
   the `latexdiff` category removes a literal saved configs accept
   (`packages/texra/src/shared/constants/replacementCategories.ts`), and
   `config.json` is additive-only. Decision: keep the name with the regex
   rule moved under it, or retire it with a clear rejection.
2. **Three workspace walks.** `indentDirectory.ts` walks by hand (descends
   hidden folders, skips links, folds case), `buildDirectories.ts` globs
   (case-sensitive on Linux, though the managed-directory rule says names
   compare case-insensitively), and `listWorkspaceFiles` is the general
   walker. Decision: the symlink policy, which `indentDirectory.ts` chose on
   purpose.
3. **"Remove each path, log failures".** Four copies
   (`buildDirectories.ts`, `acceptedFileTarget.ts`, `latexindentpt.ts`,
   `packLatexdiffvc.ts`); the last fails fast, which may be intended. Weak.

## Open: copy the terminal restates

Each needs a wording decision; nothing in the repo pins the CLI words
except the TUI titles in `validate-tui.mjs`.

1. **How a run ended.** `CLI_RUN_STATUS` and `runOutcomeToCliRunStatus`
   (`packages/cli/src/schemas/cliOutput.ts`), `historyStanding`
   (`packages/cli/src/runtime/history.ts`) and `runStatusLabel`
   (`packages/texra/src/ui/copy/runStatus.ts`) word one cancelled run as
   "interrupted", "cancelled" and "Stopped". Proposed owner:
   `runStatusLabel`.
2. **A request's heading.** Bash, edit, proposal, retry and plan requests
   are headed separately by the web panels, the TUI modals and the headless
   summaries (`packages/cli/src/runtime/approval/approvalSummaries.ts`); the
   headless tool-edit header shows an absolute path in one branch and a
   relative one in the other, and a plan is dumped as JSON.
   `toolEditDiffLabel` (`packages/texra/src/ui/copy/toolEditPreview.ts`)
   already exists for one of them.
3. **Skipping a user question.** The CLI sends
   `USER_QUESTION_SKIPPED_FEEDBACK` as the decline note
   (`packages/cli/src/runtime/headless/userQuestionAnswer.ts`), so the model
   reads "declined to answer: User question skipped by user." where the web's
   `declineDecision` sends no note. Real drift in what the model reads.
4. **"Pass N" and "Revision N".** `passLabel`
   (`packages/texra/src/ui/copy/taskDiagnostics.ts`) and `formatRoundLabel`
   name one round with two nouns in the same view.
5. **Section painting.** A one-line range reads `:5-5` in the TUI and `:5`
   on the web; "Feedback:" against "User Instruction:".
6. **Token breakdown at TUI exit.** `formatResumeUsage`
   (`packages/cli/src/chat/tui/state/resumeHint.ts`) shows cached reads as
   added to input, which already includes them, and omits cache writes.
