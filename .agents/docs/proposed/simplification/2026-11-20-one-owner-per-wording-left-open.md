# One owner per wording: what the 2026-11-20 consolidation audit left

Date: 2026-11-20
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions of
what the language, Node or an existing helper already provides. The scans
found almost no line-level clones; what remained was one rule written several
ways. These landed in the PR that adds this note:

- Every logged failure goes through `logFailure` with its module's channel
  (26 sites; closes item 1 of `2026-11-19-helpers-written-by-hand-left-open.md`).
- Model-facing counts use `formatCount` (`en-US`), not the host's locale.
- `read_file` reads through `readNormalizedFile`, as the edit tools do.
- The LaTeX preview locates files with `pathToLocationIn`.
- texcount reads `\usepackage[UTF8]{ctex}` through `loadedPackages` and
  `documentClass` (`packages/texra/src/latex/latexParsingUtils.ts`).
- Counted nouns use `formatResultCount` instead of `N thing(s)`.
- The CLI's browser launch asks `runsInWsl`.
- `entryLine` and `entryDetail` word a log entry for every sink, the desktop
  log pane included.

## Open

Each needs a decision or changes behavior beyond a consolidation.

1. **Which shell is the user's.** `packages/desktop/src/main/desktopPtyHost.ts`
   and `packages/texra/src/tools/setup/ProbeEnvironmentTool.ts` read `SHELL`
   first; `packages/harness/src/agent/prompt/workspaceInfo.ts` reads `ComSpec`
   on Windows. With Git Bash's `SHELL` set, the terminal says bash while the
   system prompt says cmd. Decide the precedence, then one harness reader.
2. **A file path to a language id, twice.** Taken on 2026-11-21: one
   extension table in `packages/texra/src/ui/highlighting/languageForPath.ts`
   over the union of both, with Monaco's and highlight.js's renames beside it;
   the desktop's `monacoLanguage.ts` and the progress view's
   `getLanguageFromPath` are gone.
3. **Newest-first runs, three orders.** `packages/harness/src/shared/runs/runOrdering.ts`
   orders by `createdAt`, as `SessionView` documents; `executionListing.ts`
   (`packages/harness/src/tools/executions/`) and
   `packages/harness/src/agent/storage/runListing.ts` order by `launchedAt`,
   the latter by parsing back an ISO string it built. Moving them to the owner
   changes the listing order where wall clock and commit order disagree.
4. **A diff file named after an output path.** Landed 2026-11-21:
   `outputSlotName` (`packages/texra/src/agent/output/compileCheck.ts`)
   names an output's compile log, build folder and diff, so `a/b.tex` and
   `a_b.tex` no longer write one `diffs/a_b.tex.diff`. It sits beside the
   compile check, not `revisionLayout`: the diff writer already imports
   `agent/output/`. Was: `packages/texra/src/tools/documents/documentResult.ts`
   replaced only the separators, while the compile check sanitized and added
   a hash.
5. **Lone-CR normalization, seven copies.** Taken on 2026-11-21: the CLI,
   the desktop renderer, the app's markdown and `responseLines` call
   `normalizeLineEndings` (`packages/texra/src/shared/utils/lineEndings.ts`),
   which every one of them can import; no new `./schemas` name. Left: the
   harness's CRLF-only copies (`frontmatterFence.ts`, `gitignore.ts`,
   `toolEditApproval.ts`, `memoryFileSystem.ts`, `fsDurability.ts`,
   `splitContentLines`), a different rule that belongs to a harness sweep.
6. **Loose JSON fields in llm, twice.** `packages/llm/src/api/failureReply.ts`
   and `packages/llm/src/providers/planUsage.ts` each read string and number
   fields from untyped replies, with different trimming and numeric-string
   rules. One module keeps both strictness rules.
7. **The webview decodes a dropped `file:` URI the host decodes again**
   (`packages/texra/src/ui/progress/fileDropHandler.ts`). Sending the raw URI
   would leave `fileURLToPath` the one decoder, but it rejects a UNC host on
   POSIX, which today drops as `//host/path`.

## Left by the 2026-11-21 app sweep

Found while landing item 4 and the sweep's other findings, outside what that
sweep could edit:

- **`isTexFile`**: landed 2026-11-21. It only forwarded to
  `hasExtension(path, '.tex')`, which its two callers now call, as the
  compile check and the media pass already did.
- **`GlobFailed`**: landed 2026-11-21. It is declared, file-local, in
  `packages/texra/src/controllers/session/taskFiles.ts`, the one module that
  globs; the housekeeping module no longer does.
- **A revision's inputs are read up to three times.**
  `processInputFiles` (`packages/texra/src/latex/latexMedia.ts`) has the
  figure, dependency and TikZ readers each call `readUncommentedLatex` on
  the same file. One read per file would need the three steps' separate
  failure recovery kept, so it is a behavior question, not a consolidation.

## Checked and declined

- **`toErrorMessage` in `packages/llm/src/node.ts`** for its hand-written
  `instanceof Error` expression: `check:fact-spread` counts files that call it,
  so the call would raise the count while the copy it replaces is not counted.
- **The same in `historyQuery/childSource.ts`**: that line is the child
  process's script source, which imports nothing.
- **`Settings.defaultOf` for the three app sites that decode `undefined`**
  (item 2 of the 2026-11-19 note): two of them are in the settings webview,
  which cannot import `./plugins`.
- **`Equal.equals` for `stableStringify(a) === stableStringify(b)`**: the two
  differ on `undefined` keys, and `Equal` caches hashes on objects a run
  later mutates.
