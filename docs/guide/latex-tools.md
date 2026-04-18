# LaTeX Tools

TeXRA doesn't just send text to an AI and hope for the best. It plugs into battle-tested LaTeX tools so formatting, diffing, figure extraction, and citation lookup are handled by the right software — not by a language model guessing at syntax.

## Overview

| What it does                                                         | Tool behind the scenes     |
| -------------------------------------------------------------------- | -------------------------- |
| <i class="codicon codicon-symbol-keyword"></i> Code formatting       | `latexindent` or `tex-fmt` |
| <i class="codicon codicon-diff-single"></i> Version comparison       | `latexdiff`                |
| <i class="codicon codicon-symbol-numeric"></i> Document statistics   | `texcount`                 |
| <i class="codicon codicon-file-media"></i> Figure extraction         | Built-in                   |
| <i class="codicon codicon-symbol-structure"></i> TikZ compilation    | Built-in                   |
| <i class="codicon codicon-book"></i> Bibliography resolution         | Built-in                   |
| <i class="codicon codicon-symbol-operator"></i> Symbolic math        | `wolfram`                  |

All are configured from **Dashboard → Tools** (<i class="codicon codicon-tools"></i>) or **Dashboard → LaTeX** (<i class="codicon codicon-file-code"></i>). Missing dependencies show <i class="codicon codicon-warning"></i> **Not Found**; ready ones show <i class="codicon codicon-check"></i> **Available**.

## <i class="codicon codicon-symbol-keyword"></i> Formatting Tools

TeXRA uses formatters to keep LaTeX code consistent and readable.

**Supported formatters:**

- **`latexindent`** — the default formatter; highly configurable
- **`tex-fmt`** — a faster alternative with simpler configuration

Formatting runs automatically after agent execution and is also available via the Command Palette (`Ctrl+Shift+P`) → **TeXRA: Format Document**.

**Configuration:** Formatter selection and installation live on the **LaTeX** tab (<i class="codicon codicon-file-code"></i>) of the TeXRA Dashboard. See [Configuration](./configuration.md#latex-configuration) for the full set of settings.

## <i class="codicon codicon-diff-single"></i> Version Comparison with `latexdiff`

`latexdiff` visualises changes between two versions of a document, producing a PDF with additions and deletions clearly marked. TeXRA can generate diffs automatically after an agent runs.

**Usage:**

- After an agent modifies your document, a diff PDF shows exactly what changed.
- Use `latexdiff-vc` to compare the current file against a git commit — pick the commit from the <i class="codicon codicon-git-commit"></i> **Commit** dropdown.

See the [LaTeX Diff guide](./latex-diff.md) for the full workflow.

## <i class="codicon codicon-symbol-numeric"></i> Document Statistics with `texcount`

`texcount` reports word counts, heading counts, and math element counts so the LLM can reason about document scale and structure.

**Enabling `texcount`:**

1. **For context:** toggle <i class="codicon codicon-symbol-numeric"></i> **Attach TeX Count** in the Tool Configuration dropdown — see [File Management](./file-management.md#tool-config-dropdown).
2. **As a tool:** tool-use agents can invoke `texcount` directly to analyse files on demand.

**Modes:**

- `separate` (default) — count each file independently
- `include` — follow `\input{}` / `\include{}` directives from the main file
- `sum` — aggregate totals across multiple top-level files

::: warning Requirement
`texcount` must be on your `PATH`. It ships with most TeX distributions. Check **Dashboard → Tools** (<i class="codicon codicon-tools"></i>) → **LaTeX** — if the card shows <i class="codicon codicon-warning"></i> Not Found, install it with your TeX package manager.
:::

## <i class="codicon codicon-file-media"></i> Figure Extraction

TeXRA extracts figures from your LaTeX so vision-capable models can "see" them.

### Standard Figures

The `extract_figures` tool finds `\includegraphics` references and returns the images as attachments.

**Auto-extraction:** toggle <i class="codicon codicon-wand"></i> **Auto Extract → Figures** in the main UI to include figures in every prompt automatically. See [Working with Figures](./working-with-figures.md).

### TikZ Figures

The `extract_tikz_figures` tool discovers `tikzpicture` environments, compiles them to standalone PDFs, and returns the rendered output.

**Requirements (all checked on the Tools dashboard):**

- `latexmk` (preferred) or `pdflatex`
- `GraphicsMagick` or `ImageMagick` for conversion
- `Ghostscript` for PDF processing

See the [TikZ Figures guide](./tikz-figures.md) for workflows and the [Installation guide](./installation.md) for dependency setup.

## <i class="codicon codicon-book"></i> Bibliography Extraction

The `extract_bib_entries` tool resolves citation context for your LaTeX document:

1. Finds `\bibliography{}` and `\addbibresource{}` directives
2. Loads the referenced `.bib` files
3. Returns BibTeX entries for every cited key

Useful whenever an agent needs exact citation records to edit, format, or validate references.

## <i class="codicon codicon-symbol-operator"></i> Symbolic Math with Wolfram

The `wolfram` tool executes Wolfram Language code through `wolframscript`, letting agents verify calculations or perform symbolic algebra. While not LaTeX-specific, it's invaluable for validating mathematical content in papers and derivations.

The Wolfram card sits under **Dashboard → Tools → Computation** (<i class="codicon codicon-symbol-operator"></i>). Requires a local [Wolfram Engine](https://www.wolfram.com/engine/) install.

## <i class="codicon codicon-settings-gear"></i> Configuring Tool Usage

Control how TeXRA uses these tools from the UI:

- **Tool Config Dropdown** (<i class="codicon codicon-tools"></i>): enable per-run helpers like **Attach TeX Count** (<i class="codicon codicon-symbol-numeric"></i>) or **Attach Diagnostics** (<i class="codicon codicon-tools"></i>). See [Configuration](./configuration.md#agent-execution-settings-webview-interface).
- **Auto Extract Dropdown** (<i class="codicon codicon-wand"></i>): toggle automatic extraction of Figures or TikZ Figures. See [Working with Figures](./working-with-figures.md).
- **Dashboard → Tools** (<i class="codicon codicon-tools"></i>): enable/disable whole tool groups, view install guides, and run one-click installers.

For detailed tool settings (formatter paths, TikZ processing options, etc.), see the [Configuration guide](./configuration.md).

## Next Steps

- [TikZ Figures](./tikz-figures.md) — advanced TikZ workflows
- [LaTeX Diff](./latex-diff.md) — version comparison in detail
- [Research Tools](./research-tools.md) — arXiv, Crossref, Zotero, and web search
- [Codex CLI](./codex-cli.md) — one-click Codex agent setup
