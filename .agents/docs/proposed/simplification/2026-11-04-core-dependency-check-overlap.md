# Two answers to "which core dependencies are missing"

Status: proposed. Found by a responsibility-overlap sweep on 2026-11-04;
checked against `main` on 2026-11-05.

Done: `missingLatexTools` in the catalog
(`packages/texra/src/shared/constants/latexToolchain.ts`) holds the image
rule once, over probe results rather than probing itself, because the setup
assistant also reports each tool's own status and would otherwise probe it
twice. The banner and the setup assistant both read it, `missingCoreTools`
is deleted, `ProbeEnvironmentTool` resolves the image alias from
`IMAGE_LATEX_TOOLS`, and the two sets' doc comments say why they differ. The
sections below are the state the sweep found.

## The overlap

The LaTeX and image dependency catalog (`LATEX_TOOLS` in
`packages/texra/src/shared/constants/latexToolchain.ts`) is the one list of
tools, and both consumers below derive their image list from it
(`IMAGE_LATEX_TOOLS`). What they still decide separately is the rule "either
image tool satisfies the image requirement", and what the setup assistant
hands to the model names the two tools by hand.

| Consumer          | File                                                                               | Probe                                                            | Image rule                                             | Result shape    |
| ----------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ | --------------- |
| Dependency banner | `packages/extension/src/progressView/checkCoreDependencies.ts`                     | `probeTool` over `CORE_DEPENDENCY_TOOLS` and `IMAGE_LATEX_TOOLS` | push both image tools if none is installed             | `MissingTool[]` |
| Setup assistant   | `packages/texra/src/tools/setup/toolProbing.ts` (`locateTool`, `missingCoreTools`) | `probeTool` or a PATH search, over `PROBED_LATEX_TOOLS`          | push one `IMAGE_TOOL_LABEL` entry if none is installed | `string[]`      |

`ProbeEnvironmentTool` (`packages/texra/src/tools/setup/ProbeEnvironmentTool.ts`)
resolves the `IMAGE_TOOL_LABEL` alias by hand (`locateTool('gm')`,
`locateTool('magick')`): the one place that names the image tools instead of
reading the catalog, so a third image tool reaches the banner and
`missingCoreTools` on its own and this tool not at all.

The two probe the catalog's sets differently, on purpose or not:
`CORE_DEPENDENCY_TOOLS` (the entries marked `core`: latexindent, Perl and
Ghostscript) plus `IMAGE_LATEX_TOOLS` for the banner, and
`PROBED_LATEX_TOOLS` (every entry whose `probe` is not `none`) for the setup
assistant, which also probes latexmk, pdflatex, latexdiff and texcount. The
catalog's `core: true` marks a strict subset of `probe: 'required'`, so the
two columns are not the same fact; they are two views of the catalog with no
statement of why they differ.

`probeLatexToolchain` (`packages/texra/src/latex/latexToolchain.ts`, the
doctor rows) and `LatexToolingController` (the settings view) probe the
catalog too, but decide no "missing core dependency" of their own.

## Why it matters

The banner and the setup assistant can disagree about whether the machine is
missing something, because they probe different sets, and the "either tool
satisfies" rule is written twice. A change to that rule (a third image tool
with its own alias, say) is made in two functions and one hand-written alias
resolution.

## Proposed change

Give the catalog one function, next to `probeTool` in `toolChecks.ts`, that
takes the set to probe and returns the missing core dependencies as catalog
ids with an `interchangeable` flag for the image group. The banner maps it to
`MissingTool`; the setup assistant maps it to names and the
`IMAGE_TOOL_LABEL` entry. Then:

- delete `missingCoreTools` and the image branch in `checkCoreDependencies`;
- have `ProbeEnvironmentTool` resolve the `IMAGE_TOOL_LABEL` alias from the
  catalog's image group instead of naming `gm` and `magick`;
- record in the catalog why the banner's set and the setup assistant's set
  differ (two named views), or make them one set.

Net elements: expected negative (one function and one image rule replace two
functions and one hand-written alias resolution).
