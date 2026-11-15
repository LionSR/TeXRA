# A LaTeX parser in place of the regex extraction

Status: proposed, not started. Found by the 2026-11-14 audit of hand-written
code a package could replace; checked against `main` at 4b8f417. The two
wrong results that audit reproduced are fixed in place, without the package
(see "What was fixed instead"). This note is the case for and against
taking the dependency for the rest.

## What is hand-written today

Five modules read LaTeX source with regular expressions or a character scan:

| Module                                                | Lines | Reads                                                               |
| ----------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `packages/texra/src/latex/latexParsingUtils.ts`       | 192   | comments, `\bibliography` and `\addbibresource`, comma lists        |
| `packages/texra/src/latex/extractBibliography.ts`     | 226   | citation commands and their keys                                    |
| `packages/texra/src/latex/extractFileDependencies.ts` | 124   | `\input`, `\include` and the other file-naming commands             |
| `packages/texra/src/latex/extractFigure.ts`           | 108   | `\includegraphics` and its path                                     |
| `packages/texra/src/utils/text/braceBalancedMacro.ts` | 93    | `\macro{a}{b}{c}` with nested braces, for criticism and replacement |

Only part of each file is parsing: the bibliography module also resolves
paths and reads `.bib` files (through `bibtex`), and the dependency and
figure modules probe the filesystem. The parsing share is roughly 150 to 200
lines in all, plus the 93 of `braceBalancedMacro.ts` and its suite
(`packages/texra/test/utils/text/BraceBalancedMacro.vitest.ts`).

The recurring defect is that each regex restates a piece of TeX's lexical
rules (what a comment is, where an argument starts, how braces nest) and
gets one case wrong. The audit found three: a `%` after `\\`, a `%` inside
`\url{...}`, and whitespace before an optional argument. There will be
others of the same kind: `\verb|%|`, a `verbatim` or `lstlisting`
environment, `\catcode` changes, a `%` inside `\href`'s first argument when
the braces nest, and a citation whose keys span a comment line.

## What the package is

`@unified-latex/unified-latex-util-parse` (1.8.4, MIT, published 2026-04-03)
parses a LaTeX string into an AST of macros, environments, groups, comments
and whitespace, with source positions. It tokenizes with a PEG grammar and
then attaches arguments to the macros it knows from its CTAN tables
(`\cite`, `\includegraphics`, `\input`, `\url`, `\href` and several hundred
more), so a reader asks for "every `cite` macro and its mandatory argument"
and never looks at a `%` or a brace.

## Dependency footprint

From the registry metadata; nothing was installed for this note, so the
on-disk and bundled sizes below are the registry's unpacked sizes, not a
measurement.

- Direct dependencies of `-util-parse`: ten `@unified-latex/*` packages and
  `unified@^10.1.2`.
- Those pull further `@unified-latex/*` packages (`-builder`,
  `-util-argspec`, `-util-comments`, `-util-render-info`, `-util-replace`,
  `-util-scan`, and what `-ctan` lists beyond them): about 18 to 20 packages
  under the one scope, all released together at one version.
- `unified@10` brings `vfile@5`, `bail`, `extend`, `trough`, `is-buffer`,
  `is-plain-obj` and `@types/unist`, with `vfile`'s own small dependencies.
  None of `unified`, `vfile` or `@unified-latex/*` is in `pnpm-lock.yaml`
  today, so all of it is new: roughly 30 packages.
- Unpacked size is dominated by two packages: `-util-pegjs` (2.4 MB, the
  generated grammars) and `-ctan` (0.76 MB, the macro tables). The rest are
  20 to 90 kB each. `-util-parse` itself is 0.2 MB.
- `unified@10` is one major behind (`unified@11` is current). The
  `@unified-latex` 1.8 line pins `^10.1.2`, so the app would carry the older
  major until upstream moves.

Bundled cost was not measured. The grammars are generated JavaScript and
tree-shake poorly, so expect most of `-util-pegjs` and `-ctan` in any bundle
that parses; measure with `npm run package:fast` before deciding.

## Is it safe for webview-reachable code

Two separate questions.

**Does anything webview-reachable need it?** No. Every importer of the five
modules runs in a host process:

- `packages/texra/src/latex/LatexMediaManager.ts`,
  `packages/texra/src/latex/latexdiff.ts` and
  `packages/texra/src/tools/latex/ExtractFiguresTool.ts` (the three
  extractors), which already use `node:path` and the Effect `FileSystem`;
- `packages/texra/src/replacement/advanced.ts` and
  `packages/extension/src/frontend/latex/criticismParser.ts` (the brace
  scanner), the second being the extension-host frontend, not a webview.

Nothing under `packages/texra/src/ui/` imports any of them. So the package
would enter the extension host, the desktop main process and the CLI
bundles, and no webview bundle, provided the import stays inside
`packages/texra/src/latex/` and the two callers above.

**Could it run in a webview if a later change wanted it there?** Probably,
but unverified. The `@unified-latex` packages are published for browser use
(the project's own playground runs them there) and the registry metadata
shows no Node-only dependency in the tree; `vfile@5` reaches `path`,
`process` and `url` through browser substitutes its `package.json` maps.
Whether esbuild's browser build picks those up under this repo's config was
not tested. Treat webview use as a separate decision with its own bundle
measurement, and keep the import out of `@ui/*` until then.

## What it would delete

- The comment pattern and `stripLatexComments` in `latexParsingUtils.ts`,
  with its three callers' "strip, then match" step: the AST has no comments
  in argument position.
- `CITATION_PATTERN` (`extractBibliography.ts`), `BIB_DIRECTIVE_PATTERN`
  and `collectCommaSeparatedMatches` (`latexParsingUtils.ts`), and the
  command patterns in `extractFileDependencies.ts` and `extractFigure.ts`:
  each becomes "visit macros named X, print argument N".
- `packages/texra/src/utils/text/braceBalancedMacro.ts` and its suite, if
  `\criticize` and the replacement macros are registered with their argument
  counts. Both callers use the `start` and `end` offsets to splice the
  source, so they need the parser's positions and a check that printing a
  node's range returns the original bytes.
- The class of defect, which is the real gain: the three fixed today and
  the ones listed under "What is hand-written today" that are still open.

What stays: `LATEX_CITATION_COMMANDS` (the app's list of what counts as a
citation), path resolution, the `.bib` reading, and every filesystem probe.
Net, about 250 to 300 lines of parsing and one test suite go, and about 60
to 100 lines of AST visiting arrive.

## Costs and risks

- **Malformed input.** The extractors run on drafts: unbalanced braces, a
  half-typed `\cite{`, a file that is a fragment. A regex finds what it can
  around the damage. A PEG parser's behavior on such input (recover, or
  attach the rest of the file to one group) must be checked on real broken
  files before any regex is deleted, because a silent "no citations found"
  is worse than the present defects.
- **Cost per call.** The stripper handles a 2 MB source in about 30 ms.
  A full parse will be slower by an unknown factor; the extractors run on
  every file of a project when a task collects its inputs.
- **Unknown macros.** Arguments are attached only for macros in the tables
  or registered by the caller. `LATEX_CITATION_COMMANDS` has entries
  (`\smartcite`, `\supercite`, the capitalized forms) that need checking
  against the tables and registering where absent, or they silently yield
  nothing.
- **About 30 new packages** in the supply chain for some 200 lines of
  parsing, one major of `unified` behind.

## Recommendation

Do not take it for the three extractors yet. The reproduced defects are
fixed, the remaining ones (`\verb`, verbatim environments) are rare in the
commands these extractors read, and the malformed-input question has no
answer without a spike.

The stronger candidate is `braceBalancedMacro.ts`'s two callers, where
nested arguments are the whole job and a wrong span corrupts the user's
text. A spike worth an afternoon: parse the fixtures of
`packages/extension/test/latex/CriticismParser.vitest.ts` and a handful of
deliberately broken drafts, compare spans with the scanner's, and measure
the extension-host bundle before and after. Adopt for all five modules
together if the spike shows byte-exact spans and usable results on broken
input; otherwise close this note as refused and record it in
`.agents/docs/refuted-candidates.json`.

## What was fixed instead

In the same change as this note, with a regression test each in
`packages/texra/test/latex/extractBibliography.vitest.ts`:

- `stripLatexComments` treats a `%` after an even number of backslashes as
  a comment, so `\\% \cite{x}` no longer counts `x`.
- It keeps the argument of `\url`, `\path`, `\nolinkurl` and the first of
  `\href` whole, so `\url{http://a/b%20c} \cite{real}` keeps `real`.
- The citation pattern accepts whitespace before each argument, so
  `\cite [p.~3]{key}` is read.
