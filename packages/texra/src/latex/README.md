# LaTeX tooling

Host-neutral LaTeX logic: compiling, parsing, diffing and fetching documents.
Nothing here imports `vscode`; host workflows reach it through typed ports, as
`overleafClone.ts` does, so the decision logic stays host-agnostic and
testable.

## Effect-native

The subprocess and filesystem code (`texcount.ts`, `latexdiff.ts` and
`latexdiff/`, the extractors, `overleafClone.ts`, `arxivProcessor.ts`,
`LatexMediaManager.ts`) returns `Effect` programs:

- **Nothing here runs a fiber.** The caller runs the program at its boundary
  (a tool's `execute()`, a VS Code command, a desktop handler, a CLI command).
  A new function converts together with its callers up to such a boundary; a
  Promise → Effect → Promise sandwich is rejected.
- **Cancellation is interruption.** Subprocesses spawn inside
  `Effect.tryPromise`, whose thunk gets a signal that aborts when the fiber is
  interrupted. Do not add a `signal` parameter.
- **Diagnostics are `Effect.log*`** under a channel named once with
  `withLogChannel`; tests assert on the sink's entries
  (`@test/support/logSinkCapture`). `Debug` entries below the host's
  `MinimumLogLevel` are dropped (the CLI shows them with `--verbose`).
  `LatexMediaManager`'s `LatexTrace` is the run's product trace, not logging.

## Files

- **Compilation**: `texTools.ts` (kpathsea search path, `compileLatex2Pdf`);
  `latexToolchain.ts` (the CLI tools TeXRA needs, type-checked against
  `@texra/shared/constants/latexToolchain`, which catches a removed tool but
  not a missing new one); `latexLogging.ts` (the shared channel for
  `texcount.ts`, `formatter/` and the extension's latexdiff commands; other
  `LaTeXdiffService` callers pass their own).
- **Extraction**: `extractFigure.ts` (figure paths); `extractBibliography.ts`
  (bibliography references and citation keys from source, then entries from
  the `.bib` files: two stages with different inputs);
  `extractFileDependencies.ts` (`\input`, `\include`, bibliography targets and
  local `.sty` files, for `LatexMediaManager` to mirror);
  `latexParsingUtils.ts` (comment stripping and bibliography-directive
  matching shared by the extractors; put new shared parsing here);
  `labelSearch.ts` (`\label{}` lookup); `criticismParser.ts` (`\criticize{}`
  annotations; `replacement/advanced.ts` strips them with the same macro
  scanner).
- **Output**: `texcount.ts` (word counts); `latexdiff.ts`
  (`LaTeXdiffService`: one diff in its direct, VC, per-round or between-round
  form).
- **Media and files**: `LatexMediaManager.ts` (compiles PDFs and mirrors
  figure dependencies into run storage; stateless); `TikzPictureManager.ts`
  (standalone TikZ rendering); `acceptedFileTarget.ts` (where an accepted file
  lands, and the write).
- **Remote sources**: `arxivIdentifier.ts` and `arxivProcessor.ts` (arXiv IDs
  and source archives); `overleafProject.ts` (pure parsing and URL and
  credential derivation for an Overleaf remote; I/O-free Overleaf logic goes
  here) and `overleafClone.ts` (the clone workflow; on an auth failure it
  clears the token and reports, without retrying).

## Subdirectories

- **`formatter/`**: `latexindentpt.ts` (`latexindent`) and `texfmt.ts`
  (`tex-fmt`) backends, `texFormatter.ts` (picks one from the workspace
  setting), `indentDirectory.ts` (a whole directory).
- **`latexdiff/`**: whole-run diffing around `LaTeXdiffService`.
  `diffOperations.ts` (`runLatexdiffForRun`) is the entry the VS Code command
  and the desktop toolbar call with the run's rounds (`runOutputFiles`); the
  CLI goes through the agent's `LatexDiffManager` instead.
  `diffCommandExecutor.ts` runs the operations, `diffFileNameManager.ts` names
  outputs, `diffFileProcessor.ts` post-processes a direct or VC diff (restores
  bibliography directives, sanitizes `\DIFadd`/`\DIFdel`), and `latexdiffCopy.ts`
  holds the outcome strings both hosts print.
