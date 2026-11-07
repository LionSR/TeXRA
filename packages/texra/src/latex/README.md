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
  `texcount.ts`, `formatter/` and the GUI hosts' latexdiff verbs; other
  `latexdiff` callers name their own with `withLogChannel`).
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
- **Output**: `texcount.ts` (word counts); `latexdiff.ts` (`latexdiff` and
  `latexdiffAgainstCommit`: one run of the tool, its `--flatten` fallback and
  the clean-up of its output, which restores bibliography directives and
  sanitizes `\DIFadd`/`\DIFdel`; it succeeds with the diff's path or fails
  with a typed error).
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
- **`latexdiff/`**: the diffs of a document task's rounds around
  `latexdiff`. `diffOperations.ts` (`latexdiffPairs`) is the one pairing of a
  round's outputs, which the run's `document_diff` pass
  (`agent/output/revisionLatexdiffs.ts`) and the hosts' verb share.
  `latexdiffVerbs.ts` is the one body of the GUI hosts' latexdiff verbs (two
  files, against a commit, a whole run), with the guards, refusals and
  notices; a whole run opens the diffs its rounds recorded and diffs only a
  round that recorded none. A host supplies only how a diff opens and how
  progress shows. `diffFileNameManager.ts` names outputs.
