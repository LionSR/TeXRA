# LaTeX source facts with two owners, and copy the CLI restates

Date: 2026-11-18
Status: proposed (the LaTeX findings have landed; of the terminal copy,
items 3, 5 and 6 are closed and 1, 2 and 4 wait for a wording decision)
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
   (The tool went with the `latex-extract` plugin on 2026-11-19.)
4. **An output's display name.** The compile check restated
   `outputDisplayName` (`packages/texra/src/shared/plugins/documentOutputs.ts`)
   without the lineage document.
5. **The build folder.** `LATEX_BUILD_DIRECTORY`
   (`packages/texra/src/common/files/fileHandlingRules.ts`) and
   `perInputBuildDirectory` (`packages/texra/src/latex/texTools.ts`).
6. **Nine symbols with an entity row and no glyph row** join
   `MATH_SYMBOL_SPELLINGS`; this closes app fact 1 of
   `2026-11-15-host-rules-and-app-facts-with-two-owners.md`.

## Landed in the follow-up (LaTeX)

The three open LaTeX findings, with their decisions, landed together.

1. **The latexdiff blank-line fix runs in two categories.** The name was
   kept, since `config.json` is additive-only and saved configs enable it.
   The regex rule, a superset of the literal one, moved out of
   `LATEXDIFF_MARKUP_REPLACEMENTS` to be `LATEXDIFF_REPLACEMENTS`
   (`packages/texra/src/replacement/rulesRegex.ts`), and the literal copy is
   gone. `latexdiff` is still enabled in the plain-rule setting, and the
   engine runs its rule in the regex pass, in the slot the duplicate held
   (`packages/texra/src/replacement/engine.ts`). With `latexdiff_markup` off
   and `latexdiff` on, the fix now also covers unstarred environments and
   any whitespace. With `latexdiff` off, it no longer runs at all.
2. **Three workspace walks.** `listWorkspaceFiles`
   (`packages/texra/src/common/files/workspaceFileListing.ts`) is the one
   walker. It now also reports the directories it entered, and takes
   `links: 'follow' | 'skip'`, the one policy its callers really differ on.
   The file pickers follow links. Bulk formatting and Clean Build skip them,
   because they rewrite or delete what they find. Every walk skips hidden
   entries and compares excluded directory names case-insensitively. Clean
   now finds a `Build/`, and arXiv formatting no longer descends hidden
   folders.
3. **"Remove each path, log failures".** One owner, `removeBestEffort`
   (`packages/texra/src/common/files/removeBestEffort.ts`), serves the
   build-folder removal, both stale-diff cleanups, latexindent's backups and
   `indent.log`, the LaTeX preview's temp files and the approval diff's
   temp files. `runPackLatexdiffvc` keeps failing fast: its result has no
   failure list, so continuing would report "cleaned" over a file it could
   not delete.
4. **The History and Diffs folder names.** The managed-directory list said
   `'history'` and `'diffs'`, while the packs wrote to `HISTORY_DIR` and a
   `'Diffs'` literal. These are now `PACKED_RUNS_DIRECTORY` and
   `PACKED_DIFFS_DIRECTORY` in
   `packages/texra/src/common/files/fileHandlingRules.ts`, and the managed
   list derives from them.

Still open on the LaTeX side: `collectFilesFromPatterns`
(`packages/texra/src/housekeeping/artifactFiles.ts`) looks for build files
in `<dir>/build`, but `perInputBuildDirectory` compiles into
`<dir>/build/<stem>`. The latexdiff round build in
`packages/texra/src/agent/output/revisionLatexdiffs.ts` shares one `build/`
across a round's diffs. Which layout is right needs a decision first.

## Open: copy the terminal restates

Items 1, 2 and 4 each need a wording decision; nothing in the repo pins
the CLI words except the TUI titles in `validate-tui.mjs`.

1. **How a run ended.** Taken on 2026-11-20: the headless chat result's
   status line, a failed program's text result and `historyStanding`
   (`packages/cli/src/runtime/history.ts`, which the `/resume` form reads
   too) word an outcome through `runStatusLabel`
   (`packages/texra/src/ui/copy/runStatus.ts`), so a cancelled run reads
   "Stopped" everywhere a person reads it. `CLI_RUN_STATUS` and
   `runOutcomeToCliRunStatus` fed only that text line and are gone; the
   JSON and NDJSON `outcome` values and the exit codes are unchanged.
2. **A request's heading.** Taken on 2026-11-20: every kind's ask and
   action words were already `@ui/copy/requestCards.ts`'s, and the headless
   plan prompt already printed the plan's objective, as the web panel and
   the TUI card do. What was left was the headless tool edit, headed by an
   absolute path when its preview loaded and a relative one when it did
   not: both branches now head it with `toolEditDiffLabel`
   (`packages/texra/src/ui/copy/toolEditPreview.ts`), the title the editor
   hosts give the same diff, and the diff names the workspace-relative
   path. The CLI's own `toolEditAsk` is gone.
3. **Skipping a user question.** Closed, checked on 2026-11-19: the
   `USER_QUESTION_SKIPPED_FEEDBACK` note is gone, and the terminal declines
   through the web's `declineDecision`
   (`packages/texra/src/shared/session/surfaceDecision.ts`).
4. **"Pass N" and "Revision N".** `passLabel`
   (`packages/texra/src/ui/copy/taskDiagnostics.ts`) and `formatRoundLabel`
   name one round with two nouns in the same view.
5. **Section painting.** Taken on 2026-11-19: `formatLineRange`
   (`packages/texra/src/ui/copy/format.ts`) writes a file's range for both
   hosts, so a one-line range reads `:5` in the terminal as on the web. The
   label was already one: `TOOL_USER_FEEDBACK_LABEL`
   (`packages/texra/src/ui/copy/runStatus.ts`).
6. **Token breakdown at TUI exit.** Closed, checked on 2026-11-19:
   `formatResumeUsage` (`packages/cli/src/chat/tui/state/resumeHint.ts`)
   prints the counters of `visibleTokenStats`
   (`packages/texra/src/ui/copy/tokenUsage.ts`), the web usage strip's.
