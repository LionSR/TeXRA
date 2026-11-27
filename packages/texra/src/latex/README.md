# LaTeX tooling

Host-neutral LaTeX logic: compiling, parsing, diffing and fetching documents.
Nothing here imports `vscode`; host workflows reach it through typed ports, as
`overleafClone.ts` does, so the decision logic stays host-agnostic and
testable.

## Effect-native

The subprocess and filesystem code (`texcount.ts`, `latexdiff.ts` and
`latexdiff/`, `overleafClone.ts`, `arxivProcessor.ts`) returns `Effect`
programs:

- **Nothing here runs a fiber.** The caller runs the program at its boundary
  (a tool's `execute()`, a VS Code command, a desktop handler, a CLI command).
  A new function converts together with its callers up to such a boundary; a
  Promise → Effect → Promise sandwich is rejected.
- **Cancellation is interruption.** Subprocesses run through the harness's
  `executeCommand`, which kills the child from its finalizer when the fiber is
  interrupted. Do not add a `signal` parameter.
- **Diagnostics are `Effect.log*`** under a channel named once with
  `withLogChannel`; tests assert on the sink's entries
  (`@test/support/logSinkCapture`). `Debug` entries below the host's
  `MinimumLogLevel` are dropped (the CLI shows them with `--verbose`).

## Files

- **Compilation**: `texTools.ts` (kpathsea search path, `compileLatex2Pdf`);
  `latexToolchain.ts` (the one probe over the tools the
  `@texra/shared/constants/latexToolchain` catalog lists, and the tools the
  dependency banner names as missing); `latexLogging.ts` (the shared channel for
  `texcount.ts` and `formatter/`; `latexdiff` callers name their own with
  `withLogChannel`).
- **Parsing**: `latexParsingUtils.ts` (comment stripping, the packages and
  class a file loads); `labelSearch.ts` (`\\label{}` lookup);
  `criticismParser.ts` (the positions of the `\\criticize` annotations, for
  the editor's inline decorations).
- **Output**: `texcount.ts` (word counts); `latexdiff.ts` (`latexdiff`:
  one run of the tool, its `--flatten` fallback and
  the clean-up of its output, which restores bibliography directives and
  sanitizes `\DIFadd`/`\DIFdel`; it succeeds with the diff's path or fails
  with a typed error).
- **Figures**: `tikzPictures.ts` (standalone TikZ rendering).
- **Remote sources**: `arxivIdentifier.ts` and `arxivProcessor.ts` (arXiv IDs
  and source archives); `overleafProject.ts` (pure parsing and URL and
  credential derivation for an Overleaf remote; I/O-free Overleaf logic goes
  here) and `overleafClone.ts` (the clone workflow; on an auth failure it
  clears the token and reports, without retrying).

## Subdirectories

- **`formatter/`**: `latexindentpt.ts` (`latexindent`) and `texfmt.ts`
  (`tex-fmt`) backends, `texFormatter.ts` (picks one from the workspace
  setting), `indentDirectory.ts` (a whole directory).
- **`latexdiff.ts`, `latexdiff/`**: one `latexdiff` of two files and the
  name of the diff it writes, for the approval preview of a `.tex` edit
  (`controllers/approval/latexPreview.ts`).
