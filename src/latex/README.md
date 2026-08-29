# LaTeX tooling

Host-neutral LaTeX domain logic: compiling, parsing, diffing, and fetching
documents. No file here imports `vscode`; host wiring (commands, UI prompts)
stays in the extension/desktop/CLI layers and reaches this code through typed
ports (see `overleafClone.ts`) rather than the other way around.

The files have distinct roles:

- **Compilation** — `texTools.ts` builds the kpathsea search path and runs
  `compileLatex2Pdf`; `latexToolchain.ts` lists the core CLI tools TeXRA
  depends on, kept in sync with `@shared/constants/latex`'s SSOT by a
  type-level check; `latexLogging.ts` defines the one shared log channel
  every tool-shell-out module (tex-fmt, latexindent, texcount, latexdiff, …)
  logs under.
- **Content extraction** — `extractFigure.ts` and `extractBibliography.ts`
  pull figure paths and bibliography entries out of LaTeX source;
  `extractFileDependencies.ts` resolves `\input`/`\include`/`\bibliography`
  targets so `LatexMediaManager` can mirror them into run storage.
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
  to `texcount` for word/character counts. `latexdiff.ts` runs `latexdiff`
  between two revisions.
- **Media and file management** — `LatexMediaManager.ts` owns per-workspace
  media state and dependency mirroring; `TikzPictureManager.ts` extracts and
  renders standalone TikZ pictures; `acceptedFileTarget.ts` resolves where an
  accepted/edited file should land and commits the replacement;
  `mergeFileUtils.ts` parses the `_rN_`-suffixed filenames TeXRA's merge
  workflow generates.
- **Remote sources** — `arxivIdentifier.ts` normalizes an arXiv ID out of a
  URL or bare string; `arxivProcessor.ts` downloads and unpacks arXiv source
  archives. `overleafProject.ts` is the pure, host-neutral parsing and
  credential/URL derivation for an Overleaf git remote; `overleafClone.ts` is
  the workflow built on top of it (precondition checks, clone execution,
  auth-failure retry) — new Overleaf logic that doesn't need I/O belongs in
  `overleafProject.ts`, not `overleafClone.ts`.

New parsing helpers that more than one extractor needs belong in
`latexParsingUtils.ts`; new host-facing workflows should take their side
effects through a ports interface the way `overleafClone.ts` does, so the
decision logic stays unit-testable and host-agnostic.
