# Two answers to "which core dependencies are missing"

Status: proposed. Found by a responsibility-overlap sweep on 2026-11-04.

## The overlap

The LaTeX and image dependency catalog (`LATEX_TOOLS` in
`packages/texra/src/shared/constants/latexToolchain.ts`) is the one list of
tools. Two consumers still decide "which core dependencies are missing"
separately, each with its own copy of the rule "either image tool satisfies the
image requirement":

| Consumer | File | Probe | Image rule | Result shape |
| --- | --- | --- | --- | --- |
| Dependency banner | `packages/texra/src/utils/system/checkCoreDependencies.ts` | `probeTool` over `CORE_DEPENDENCY_TOOLS` and `IMAGE_LATEX_TOOLS` | push both image tools if none installed | `MissingTool[]` |
| Setup assistant | `packages/texra/src/tools/setup/toolProbing.ts` (`locateTool`, `missingCoreTools`) | `probeTool` or a PATH search, over `PROBED_LATEX_TOOLS` | push one `IMAGE_TOOL_LABEL` entry if none installed | `string[]` |

Two further entries in the same area differ only in what they do with the
result: `probeLatexToolchain` (`packages/texra/src/latex/latexToolchain.ts`, the
doctor rows) and `LatexToolingController` (the settings view).

The image-tool alias `IMAGE_TOOL_LABEL` is also resolved by hand in
`ProbeEnvironmentTool` (`locateTool('gm')`, `locateTool('magick')`), a third
statement of the same rule.

## Why it matters

A change to the image requirement (a third tool, a different alias) has to be
made in three places, and the banner and the setup assistant can disagree about
whether the machine is missing something. The catalog's `probe` and `core`
columns encode the same fact in two ways (`probe: 'required' | 'image'` and
`core: true`), which is the sign of a second owner.

## Proposed change

Give the catalog one function, next to `probeTool` in `toolChecks.ts`, that
returns the missing core dependencies as catalog ids with an `interchangeable`
flag for the image group. The banner maps it to `MissingTool`; the setup
assistant maps it to names and the `IMAGE_TOOL_LABEL` entry. Then:

- delete `missingCoreTools` and the image branch in `checkCoreDependencies`;
- have `ProbeEnvironmentTool` resolve the `IMAGE_TOOL_LABEL` alias from the
  catalog's image group instead of naming `gm` and `magick`;
- drop one of `probe: 'required'` and `core: true` if the two columns turn out
  to be equal after this.

Check first: `CORE_DEPENDENCY_TOOLS` vs `PROBED_LATEX_TOOLS` membership (the
banner probes latexindent, Perl and Ghostscript; the setup tool also probes
`latexmk` and `pdflatex`, so the two sets are not equal today and the shared
function needs the set as a parameter or two named views). If they differ on
purpose, record that in the catalog and keep only the shared image rule.

Net elements: expected negative (one function, one image rule, one alias
resolution replace three).
