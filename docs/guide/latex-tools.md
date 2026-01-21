# LaTeX Tools

TeXRA integrates specialized external tools for LaTeX processing.

## Overview

LaTeX documents require precision in formatting, compilation, and analysis. Rather than relying solely on the LLM, TeXRA leverages dedicated tools for these tasks:

| Tool                      | Purpose                 |
| ------------------------- | ----------------------- |
| `latexindent` / `tex-fmt` | Code formatting         |
| `latexdiff`               | Version comparison      |
| `texcount`                | Document statistics     |
| `extract_figures`         | Figure asset extraction |
| `extract_tikz_figures`    | TikZ compilation        |
| `extract_bib_entries`     | Bibliography resolution |

## Formatting Tools

TeXRA uses formatters to ensure consistent, readable LaTeX code.

**Supported formatters:**

- **latexindent** - The default formatter, highly configurable
- **tex-fmt** - A faster alternative with simpler configuration

Formatting runs automatically after agent execution and is available via the `TeXRA: Format Document` command.

**Configuration:** See [VS Code Settings](./configuration.md#latex-configuration) for formatter selection and options.

## Version Comparison with latexdiff

The `latexdiff` tool visualizes changes between document versions, generating a PDF with additions and deletions clearly marked. TeXRA can automatically generate diffs after agent runs.

**Usage:**

- After an agent modifies your document, a diff PDF shows exactly what changed
- Use `latexdiff-vc` to compare against git history

**Configuration:** See the [LaTeX Diff guide](./latex-diff.md) for detailed setup and options.

## Document Statistics with texcount

`texcount` provides document statistics including word counts, heading counts, and math element counts. This information helps the LLM understand document scale and structure.

**Enabling texcount:**

1. **For context:** Enable "Attach TeX Count" in the Tool Configuration dropdown (see [File Management](./file-management.md#tool-config-dropdown))
2. **As a tool:** Tool-use agents can invoke `texcount` directly to analyze files on demand

**Modes:**

- `separate` (default) - Count each file independently
- `include` - Follow `\input{}`/`\include{}` directives from the main file
- `sum` - Aggregate totals across multiple top-level files

::: warning Requirement
Ensure `texcount` is in your system's PATH. It's typically included with TeX distributions.
:::

## Figure Extraction

TeXRA extracts and processes figures for AI analysis.

### Standard Figures

The `extract_figures` tool finds figure references (`\includegraphics`) and returns the images as attachments, allowing the LLM to "see" your figures.

**Auto-extraction:** Enable "Auto Extract Figures" in the UI to automatically include figures in prompts. See [File Management](./file-management.md#auto-extraction-features).

### TikZ Figures

The `extract_tikz_figures` tool discovers TikZ environments, compiles them to standalone PDFs, and returns the rendered output.

**Requirements:**

- `latexmk` (preferred) or `pdflatex`
- `GraphicsMagick` or `ImageMagick` (for conversion)
- `Ghostscript` (for PDF processing)

See the [TikZ Figures guide](./tikz-figures.md) for detailed workflows and the [Installation guide](./installation.md) for dependency setup.

## Bibliography Extraction

The `extract_bib_entries` tool resolves bibliography context for your LaTeX document:

1. Finds `\bibliography{}` and `\addbibresource{}` directives
2. Loads the referenced `.bib` files
3. Returns BibTeX entries for every cited key

This is useful when the agent needs exact citation records to edit, format, or validate references.

## Symbolic Math with Wolfram

The `wolfram` tool executes Wolfram Language code through `wolframscript`, letting agents verify calculations or perform symbolic algebra. While not LaTeX-specific, it's particularly useful for validating mathematical content in your documents.

## Configuring Tool Usage

Control how TeXRA uses tools through the UI:

- **Tool Config Dropdown:** Enable/disable helpers like "Attach TeX Count" or "Attach Diagnostics" for the current run. See [File Management](./file-management.md#tool-config-dropdown).
- **Auto Extract Dropdown:** Enable/disable automatic extraction of Figures or TikZ Figures. See [File Management](./file-management.md#auto-extraction-features).

For detailed tool settings (formatter paths, TikZ processing options, etc.), see the [Configuration guide](./configuration.md).

## Next Steps

- [TikZ Figures](./tikz-figures.md) - Advanced TikZ workflows
- [LaTeX Diff](./latex-diff.md) - Version comparison in detail
- [Research Tools](./research-tools.md) - arXiv, Crossref, and web search
