# Tool Integration: Enhancing AI Capabilities

While Large Language Models (LLMs) are incredibly powerful, TeXRA integrates specialized external tools to handle tasks requiring precision, specific formatting, or analysis beyond the LLM's core capabilities. This approach aligns with best practices for building effective AI agents (as discussed by researchers at institutions like Anthropic), where leveraging specialized tools is a key design pattern. This ensures higher quality results, better consistency, and more robust handling of complex academic documents, especially LaTeX.

This guide provides an overview of the types of tools TeXRA uses and how they enhance the agent workflows.

## Integrated Tool Categories

TeXRA leverages tools primarily in these areas:

### 1. LaTeX Processing

Ensuring clean, consistent, and valid LaTeX code.

- **Formatting:** Formatters such as `latexindent` or `tex-fmt` are used automatically after agent runs (and via command) to ensure consistent code style and readability. Configure formatting options in [VS Code Settings](./configuration.md#latex-configuration).
- **Comparison:** `latexdiff` is used to visualize changes between document versions, including automatic diff generation after agent runs. See the [LaTeX Diff guide](./latex-diff.md) for details on usage and configuration.

**TeX Count Integration:**
TeXRA can use `texcount` (often included with LaTeX) to provide document statistics (words, headers, math) to the AI agent. This is enabled via the "Attach TeX Count" (<i class="codicon codicon-symbol-numeric"></i>) checkbox in the Tool Configuration dropdown (see [Configuration Guide](./configuration.md#agent-execution-settings)). Ensure `texcount` is in your system's PATH.

### 2. Figure & Media Handling

Processing visual elements for analysis and inclusion.

- **Extraction:** TeXRA can automatically find figure references (`\includegraphics`) and extract TikZ environments from your LaTeX source. See the [TikZ Figures guide](./tikz-figures.md) and the "Auto Extract" options in the UI ([File Management guide](./file-management.md#auto-extraction-features)).
- **Conversion/Compilation:** Tools like `latexmk` (preferred when available) or `pdflatex`, along with `GraphicsMagick`/`ImageMagick` and `Ghostscript`, are used behind the scenes to compile extracted TikZ code and convert PDFs/images into formats suitable for the LLM (previews for you, data for the AI). Installation of these external dependencies is covered in the [Installation guide](./installation.md). Configuration options are in [VS Code Settings](./configuration.md#latex-configuration).

### 3. Document Analysis

Providing quantitative insights into your document structure.

- **Statistics:** `texcount` analyzes your document to provide statistics like word counts, heading counts, and math element counts. This information can optionally be included in prompts to give the LLM better context about the document's scale and complexity. See the "Attach TeX Count" option in the UI ([File Management guide](./file-management.md#tool-config-dropdown)) and the `texra.getTeXCount` command.
- **Symbolic Math:** The `wolfram` tool runs Wolfram Language code through `wolframscript`, letting agents verify calculations or perform algebra before responding.

_(Note: These tools often rely on external programs that need to be installed separately. See the [Installation guide](./installation.md) for requirements.)_

## How Tools Enhance Agents

Tool integration improves agent performance and reliability:

- **Better Context for LLM:** Providing structured data like figure previews or document statistics (`texcount` output) helps the LLM understand the full context beyond just the raw text, leading to more relevant and accurate responses.
- **Handling Specialized Formats:** Tools handle the complexities of LaTeX compilation, TikZ rendering, and image conversion, allowing the LLM to focus on the content and reasoning.
- **Consistency & Quality:** Automatic formatting (using `latexindent` or `tex-fmt`) ensures outputs adhere to standards. `latexdiff` provides crucial observability.
- **Enabling New Workflows:** Features like comparing versions (`latexdiff-vc`) or checking text/figure consistency are only possible through tool integration.

The outputs of these tools are often incorporated directly or indirectly into the prompts constructed based on the [Agent Architecture](./agent-architecture.md).

## Configuring Tool Usage

You have several ways to control how TeXRA uses these tools:

- **Tool Config Dropdown (UI):** Quickly enable/disable features like "Attach TeX Count" or "Reflect" for the current run. See [File Management](./file-management.md#tool-config-dropdown).
- **Auto Extract Dropdown (UI):** Enable/disable automatic extraction of Figures or TikZ Figures for the current run. See [File Management](./file-management.md#auto-extraction-features).

For detailed configuration of specific tools (like `latexindent` or `tex-fmt`, TikZ processing paths, etc.), refer to the main [Configuration guide](./configuration.md).

By understanding how TeXRA uses tools, you can better leverage its capabilities and customize its behavior for your specific research needs. It's like giving your AI assistant superpowers!
