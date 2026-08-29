# LaTeX tooling

Host-neutral LaTeX domain logic: compiling, parsing, diffing, and fetching
documents. No file here imports `vscode`; host wiring (commands, UI prompts)
stays in the extension/desktop/CLI layers and reaches this code through typed
ports (see `overleafClone.ts`) rather than the other way around.

The files have distinct roles:

- **Compilation** — `texTools.ts` builds the kpathsea search path and runs
  `compileLatex2Pdf`; `latexToolchain.ts` lists the core CLI tools TeXRA
  depends on, checked against `@shared/constants/latexToolchain`'s SSOT by a
  type-level membership check — it catches a renamed/removed shared tool, not
  a new one added there that this list doesn't yet cover; `latexLogging.ts`
  defines the shared log channel that `texcount.ts` and the `formatter/`
  backends log under. `latexdiff/`'s
  service instead takes a caller-supplied channel (agent runs use their
  stream id; desktop and the tool-approval preview use their own) — only the
  extension's own latexdiff command group reuses this shared channel.
- **Content extraction** — `extractFigure.ts` pulls figure paths out of LaTeX
  source; `extractBibliography.ts` extracts bibliography-file references and
  citation keys from the source (`extractBibliographyContext`) and separately
  loads the actual entries from those referenced `.bib` files
  (`loadBibliographyEntries`) — the two stages have different inputs, don't
  conflate them. `extractFileDependencies.ts` resolves
  `\input`/`\include`/`\bibliography` targets so `LatexMediaManager` can
  mirror them into run storage.
  `latexParsingUtils.ts` holds the comment-stripping and bibliography-directive
  matching those two extractors share — add new shared parsing there rather
  than duplicating it in either extractor. `labelSearch.ts` scans files for a
  `\label{}` definition. `criticismParser.ts` parses `\criticize{}` review
  annotations (the counterpart that strips them lives in
  `replacement/advanced.ts`, both built on the same shared brace-balanced
  macro scanner).
- **Output processing** — `texraResponseTextProcessing.ts` is the LaTeX-owned
  policy for cleaning up and joining a model's continued LaTeX output; the
  agent runtime only supplies the connector strategy. `texcount.ts` shells out
  to `texcount` for word/character counts. `latexdiff.ts` defines
  `LaTeXdiffService`, which executes a single diff (invokes the command,
  writes and post-processes the output) in its direct/VC/per-round/
  between-round forms; the `latexdiff/` subdirectory below adds full-run
  discovery and operation planning around it, not the execution itself.
- **Media and file management** — `LatexMediaManager.ts` compiles PDFs and
  mirrors figure dependencies into run storage, writing results into a
  `MediaWorkspaceState` the caller owns (the manager itself holds only a
  logger and an optional file service, no state);
  `TikzPictureManager.ts` extracts and renders standalone TikZ pictures;
  `acceptedFileTarget.ts` resolves where an
  accepted/edited file should land and commits the replacement;
  `mergeFileUtils.ts` parses the `_rN_`-suffixed filenames TeXRA's merge
  workflow generates.
- **Remote sources** — `arxivIdentifier.ts` normalizes an arXiv ID out of a
  URL or bare string; `arxivProcessor.ts` downloads and unpacks arXiv source
  archives. `overleafProject.ts` is the pure, host-neutral parsing and
  credential/URL derivation for an Overleaf git remote; `overleafClone.ts` is
  the workflow built on top of it (precondition checks, clone execution,
  auth-failure handling — it clears the bad token and reports the failure,
  it does not retry the clone itself) — new Overleaf logic that doesn't need
  I/O belongs in `overleafProject.ts`, not `overleafClone.ts`.

## Subdirectories

- **`formatter/`** — the local-formatter backends `latexindentpt.ts` (runs
  `latexindent`) and `texfmt.ts` (runs `tex-fmt`) wrap, `texFormatter.ts`
  resolves which one a workspace setting selects and runs it, and
  `indentDirectory.ts` applies it across a whole directory.
- **`latexdiff/`** — full-run discovery and operation planning around
  `LaTeXdiffService`. `runLatexdiff.ts` is the host-neutral entry point the
  VS Code command and the desktop stream-toolbar action call (the CLI's
  latexdiff workflow instead goes through the agent's own `LatexDiffManager`,
  which uses `LaTeXdiffService` directly); it resolves which round outputs to
  diff via `outputDiscovery.ts`/`executionDiscovery.ts` (the latter's narrow
  port lets `latex` stay out of `@agent/storage`), then builds and dispatches
  the diff operations via `diffOperations.ts`/`diffCommandExecutor.ts`, naming
  output files with `diffFileNameManager.ts` (math markup options come from
  `mathMarkup.ts`). `service.ts` holds the shared `latexdiffService` singleton
  (used only by the extension's own command group — see the Compilation
  bullet above), `types.ts` the types those pieces share, and
  `latexdiffCopy.ts` the user-facing outcome strings both host commands print
  so they can't disagree on wording.

New parsing helpers that more than one extractor needs belong in
`latexParsingUtils.ts`; new host-facing workflows should take their side
effects through a ports interface the way `overleafClone.ts` does, so the
decision logic stays unit-testable and host-agnostic.
