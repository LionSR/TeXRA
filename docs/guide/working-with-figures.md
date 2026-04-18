# Working with Figures

TeXRA lets AI agents analyse, reference, and generate figures inside your documents — from `.png` screenshots to embedded TikZ diagrams and PDFs.

## <i class="codicon codicon-rocket"></i> Quick Task: Add a Figure Caption

1. Select the `polish` agent from the agent dropdown (<i class="codicon codicon-sparkle"></i>).
2. Pick a vision-capable model (<i class="codicon codicon-robot"></i>) — e.g. `gpt54`, `sonnet46`, `gemini31p`.
3. Select your figure in the **Media** (<i class="codicon codicon-file-media"></i>) section.
4. Type the instruction: "Write a detailed caption for this figure."
5. Click Execute (<i class="codicon codicon-play"></i>).

## <i class="codicon codicon-file-media"></i> The Media Section

The main TeXRA panel includes a **Media** section for figure files:

- **Dropdown** (<i class="codicon codicon-file-media"></i>): pick a primary media file from the workspace.
- **Multiple Toggle** (<i class="codicon codicon-list-unordered"></i>): expand to select multiple files.
- **Auto Extract Dropdown** (<i class="codicon codicon-wand"></i>): configure automatic figure extraction.
- **Current Button** (<i class="codicon codicon-file-code"></i>): select the figure currently open in the editor.
- **Empty Button** (<i class="codicon codicon-close"></i>): clear the selection.

## <i class="codicon codicon-file-symlink-file"></i> Supported File Types

Configurable via `texra.files.included.mediaExtensions`:

- **Images**: `.png`, `.jpeg`, `.jpg`, `.gif`, `.heic`, `.heif`, `.webp`
- **Documents**: `.pdf` (native on Anthropic/Gemini/OpenAI, otherwise rasterised)
- **Audio** (experimental): `.wav`, `.m4a`, `.mp3`, `.aiff`, `.aac`, `.ogg`, `.flac`

PDFs use native multimodal support when the provider offers it. Otherwise TeXRA converts them via GraphicsMagick / ImageMagick + Ghostscript — status for those system dependencies lives on **Dashboard → LaTeX** (<i class="codicon codicon-file-code"></i>).

## <i class="codicon codicon-clippy"></i> Clipboard Images

Paste images directly into the instruction area:

1. Copy any image to the clipboard.
2. Paste with `Ctrl/Cmd+V`.
3. The image is saved and referenced as `[pasted_timestamp_hash.ext]`.
4. The **Media Files** list (<i class="codicon codicon-file-media"></i>) updates automatically.

Pasted images are stored temporarily and cleaned up after 3 days.

## <i class="codicon codicon-wand"></i> Automatic Figure Extraction

Enable via the **Auto Extract** dropdown (<i class="codicon codicon-wand"></i>) near the Media label:

- **Figures** (<i class="codicon codicon-file-media"></i>): extracts images from `\includegraphics` commands.
- **TikZ Figures** (<i class="codicon codicon-symbol-structure"></i>): extracts `tikzpicture` environments as `.tikz` files and compiles them.

## <i class="codicon codicon-tools"></i> Figure Extraction Tools

Tool-use agents can extract figures programmatically. These are part of the **LaTeX Extraction** built-in tool group — always available.

### `extract_figures`

Scans for `\includegraphics` and returns referenced files (up to 20 attachments):

```json
{
  "name": "extract_figures",
  "arguments": { "texPath": "paper/main.tex" }
}
```

### `extract_tikz_figures`

Extracts and optionally compiles `tikzpicture` environments (up to 12 PDFs):

```json
{
  "name": "extract_tikz_figures",
  "arguments": { "texPath": "paper/main.tex", "compile": true }
}
```

Setting `compile: true` runs `latexmk`/`pdflatex` on each snippet and attaches the resulting PDFs so multimodal models can read them directly.

### `extract_bib_entries`

Retrieves BibTeX records for every citation key found in the document.

## <i class="codicon codicon-eye"></i> Using Media Files with Models

When you provide media files, they're handed to the model according to its capabilities:

- **Vision models** (GPT-5.4, Claude 4.6 Sonnet/Opus, Gemini 3.1 Pro, …): images are encoded and attached to the prompt.
- **Audio models**: audio files are uploaded for transcription.
- **Non-multimodal models**: only filenames are passed as context.

Common use cases:

- <i class="codicon codicon-pencil"></i> Write captions for images (`polish` agent)
- <i class="codicon codicon-check"></i> Verify text matches figures (`correct` agent)
- <i class="codicon codicon-file-text"></i> Generate text from images/PDFs (`ocr` agent)
- <i class="codicon codicon-unmute"></i> Transcribe audio (`transcribe_audio` agent)

For TikZ-specific workflows, see [TikZ Figures](./tikz-figures.md).
