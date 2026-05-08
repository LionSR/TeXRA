# LaTeX Tools

TeXRA doesn't just send text to an AI and hope for the best. It plugs into battle-tested LaTeX tools so formatting, diffing, figure extraction, and citation lookup are handled by the right software — not by a language model guessing at syntax.

## Overview

| What it does                                                                  | Tool behind the scenes     |
| ----------------------------------------------------------------------------- | -------------------------- |
| <wa-icon library="texra" name="symbol-keyword"></wa-icon> Code formatting     | `latexindent` or `tex-fmt` |
| <wa-icon library="texra" name="diff-single"></wa-icon> Version comparison     | `latexdiff`                |
| <wa-icon library="texra" name="symbol-numeric"></wa-icon> Document statistics | `texcount`                 |
| <wa-icon library="texra" name="file-media"></wa-icon> Figure extraction       | Built-in                   |
| <wa-icon library="texra" name="symbol-structure"></wa-icon> TikZ compilation  | Built-in                   |
| <wa-icon library="texra" name="book"></wa-icon> Bibliography resolution       | Built-in                   |
| <wa-icon library="texra" name="symbol-operator"></wa-icon> Symbolic math      | `wolfram`                  |

All are configured from **Dashboard → Tools** (<wa-icon library="texra" name="tools"></wa-icon>) or **Dashboard → LaTeX** (<wa-icon library="texra" name="file-code"></wa-icon>). Missing dependencies show <wa-icon library="texra" name="warning"></wa-icon> **Not Found**; ready ones show <wa-icon library="texra" name="check"></wa-icon> **Available**.

## <wa-icon library="texra" name="symbol-keyword"></wa-icon> Formatting Tools

TeXRA uses formatters to keep LaTeX code consistent and readable.

**Supported formatters:**

- **`latexindent`** — the default formatter; highly configurable
- **`tex-fmt`** — a faster alternative with simpler configuration

Formatting runs automatically after agent execution and is also available via the Command Palette (`Ctrl+Shift+P`) → **TeXRA: Indent Current TeX** (or **Indent All LaTeX Files** for the whole workspace).

**Configuration:** Formatter selection and installation live on the **LaTeX** tab (<wa-icon library="texra" name="file-code"></wa-icon>) of the TeXRA Dashboard. See [Configuration](./configuration.md#latex-configuration) for the full set of settings.

## <wa-icon library="texra" name="diff-single"></wa-icon> Version Comparison with `latexdiff`

`latexdiff` visualises changes between two versions of a document, producing a PDF with additions and deletions clearly marked. TeXRA can generate diffs automatically after an agent runs.

**Usage:**

- After an agent modifies your document, a diff PDF shows exactly what changed.
- Use `latexdiff-vc` to compare the current file against a git commit — pick the commit from the <wa-icon library="texra" name="git-commit"></wa-icon> **Commit** dropdown.

See the [LaTeX Diff guide](./latex-diff.md) for the full workflow.

## <wa-icon library="texra" name="symbol-numeric"></wa-icon> Document Statistics with `texcount`

`texcount` reports word counts, heading counts, and math element counts so the LLM can reason about document scale and structure.

**Enabling `texcount`:**

1. **For context:** toggle <wa-icon library="texra" name="symbol-numeric"></wa-icon> **Attach TeX Count** in the Tool Configuration dropdown — see [File Management](./file-management.md#tool-config-dropdown).
2. **As a tool:** tool-use agents can invoke `texcount` directly to analyse files on demand.

**Modes:**

- `separate` (default) — count each file independently
- `include` — follow `\input{}` / `\include{}` directives from the main file
- `sum` — aggregate totals across multiple top-level files

::: warning Requirement
`texcount` must be on your `PATH`. It ships with most TeX distributions. Check **Dashboard → Tools** (<wa-icon library="texra" name="tools"></wa-icon>) → **LaTeX** — if the card shows <wa-icon library="texra" name="warning"></wa-icon> Not Found, install it with your TeX package manager.
:::

## <wa-icon library="texra" name="file-media"></wa-icon> Figure Extraction

TeXRA extracts figures from your LaTeX so vision-capable models can "see" them.

### Standard Figures

The `extract_figures` tool finds `\includegraphics` references and returns the images as attachments.

**Auto-extraction:** toggle <wa-icon library="texra" name="wand"></wa-icon> **Auto Extract → Figures** in the main UI to include figures in every prompt automatically. See [Working with Figures](./working-with-figures.md).

### TikZ Figures

The `extract_tikz_figures` tool discovers `tikzpicture` environments, compiles them to standalone PDFs, and returns the rendered output.

**Requirements (all checked on Dashboard → Tools):**

- `latexmk` (preferred) or `pdflatex`
- `GraphicsMagick` or `ImageMagick` for conversion
- `Ghostscript` for PDF processing

See the [TikZ Figures guide](./tikz-figures.md) for workflows and the [Installation guide](./installation.md) for dependency setup.

## <wa-icon library="texra" name="book"></wa-icon> Bibliography Extraction

The `extract_bib_entries` tool resolves citation context for your LaTeX document:

1. Finds `\bibliography{}` and `\addbibresource{}` directives
2. Loads the referenced `.bib` files
3. Returns BibTeX entries for every cited key

Useful whenever an agent needs exact citation records to edit, format, or validate references.

## <wa-icon library="texra" name="symbol-operator"></wa-icon> Symbolic Math with Wolfram

The `wolfram` tool executes Wolfram Language code through `wolframscript`, letting agents verify calculations or perform symbolic algebra. While not LaTeX-specific, it's invaluable for validating mathematical content in papers and derivations.

The Wolfram card sits under **Dashboard → Tools → Computation** (<wa-icon library="texra" name="symbol-operator"></wa-icon>). Requires a local [Wolfram Engine](https://www.wolfram.com/engine/) install.

## <wa-icon library="texra" name="settings-gear"></wa-icon> Configuring Tool Usage

Control how TeXRA uses these tools from the UI:

- **Tool Config Dropdown** (<wa-icon library="texra" name="tools"></wa-icon>): enable per-run helpers like **Attach TeX Count** (<wa-icon library="texra" name="symbol-numeric"></wa-icon>) or **Attach Diagnostics** (<wa-icon library="texra" name="tools"></wa-icon>). See [Configuration](./configuration.md#agent-execution-settings-webview-interface).
- **Auto Extract Dropdown** (<wa-icon library="texra" name="wand"></wa-icon>): toggle automatic extraction of Figures or TikZ Figures. See [Working with Figures](./working-with-figures.md).
- **Dashboard → Tools** (<wa-icon library="texra" name="tools"></wa-icon>): enable/disable whole tool groups, view install guides, and run one-click installers.

For detailed tool settings (formatter paths, TikZ processing options, etc.), see the [Configuration guide](./configuration.md).

## Next Steps

- [TikZ Figures](./tikz-figures.md) — advanced TikZ workflows
- [LaTeX Diff](./latex-diff.md) — version comparison in detail
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
- [Codex CLI](./codex-cli.md) — one-click Codex agent setup
