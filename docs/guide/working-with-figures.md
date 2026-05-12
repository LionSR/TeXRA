# Working with Figures

TeXRA lets AI agents analyse, reference, and generate figures inside your documents — from `.png` screenshots to embedded TikZ diagrams and PDFs.

## <wa-icon library="texra" name="rocket"></wa-icon> Quick Task: Add a Figure Caption

1. Select the `polish` agent from the agent dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>).
2. Pick a vision-capable model (<wa-icon library="texra" name="robot"></wa-icon>) — e.g. `gpt54`, `sonnet46`, `gemini31p`.
3. Select your figure in the **Media** (<wa-icon library="texra" name="file-media"></wa-icon>) section.
4. Type the instruction: "Write a detailed caption for this figure."
5. Click Execute (<wa-icon library="texra" name="play"></wa-icon>).

## <wa-icon library="texra" name="file-media"></wa-icon> The Media Section

The main TeXRA panel includes a **Media** section for figure files:

- **Dropdown** (<wa-icon library="texra" name="file-media"></wa-icon>): pick a primary media file from the workspace.
- **Multiple Toggle** (<wa-icon library="texra" name="list-unordered"></wa-icon>): expand to select multiple files.
- **Auto Extract Dropdown** (<wa-icon library="texra" name="wand"></wa-icon>): configure automatic figure extraction.
- **Current Button** (<wa-icon library="texra" name="file-code"></wa-icon>): select the figure currently open in the editor.
- **Empty Button** (<wa-icon library="texra" name="close"></wa-icon>): clear the selection.

## <wa-icon library="texra" name="file-symlink-file"></wa-icon> Supported File Types

Configurable via `texra.files.included.mediaExtensions`:

- **Images**: `.png`, `.jpeg`, `.jpg`, `.gif`, `.heic`, `.heif`, `.webp`
- **Documents**: `.pdf` (native on Anthropic/Gemini/OpenAI, otherwise rasterised)
- **Audio** (experimental): `.wav`, `.m4a`, `.mp3`, `.aiff`, `.aac`, `.ogg`, `.flac`

PDFs use native multimodal support when the provider offers it. Otherwise TeXRA converts them via GraphicsMagick / ImageMagick + Ghostscript — status for those system dependencies lives on **Dashboard → LaTeX** (<wa-icon library="texra" name="file-code"></wa-icon>).

## <wa-icon library="texra" name="clippy"></wa-icon> Clipboard Images

Paste images directly into the instruction area:

1. Copy any image to the clipboard.
2. Paste with `Ctrl/Cmd+V`.
3. The image is saved and referenced as `[pasted_timestamp_hash.ext]`.
4. The **Media Files** list (<wa-icon library="texra" name="file-media"></wa-icon>) updates automatically.

Pasted images are stored temporarily and cleaned up after 3 days.

## <wa-icon library="texra" name="wand"></wa-icon> Automatic Figure Extraction

Enable via the **Auto Extract** dropdown (<wa-icon library="texra" name="wand"></wa-icon>) near the Media label:

- **Figures** (<wa-icon library="texra" name="file-media"></wa-icon>): extracts images from `\includegraphics` commands.
- **TikZ Figures** (<wa-icon library="texra" name="symbol-structure"></wa-icon>): extracts `tikzpicture` environments as `.tikz` files and compiles them.

## <wa-icon library="texra" name="tools"></wa-icon> Figure Extraction Tools

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

## <wa-icon library="texra" name="eye"></wa-icon> Using Media Files with Models

When you provide media files, they're handed to the model according to its capabilities:

- **Vision models** (GPT-5.4, Claude 4.6 Sonnet/Opus, Gemini 3.1 Pro, …): images are encoded and attached to the prompt.
- **Audio models**: audio files are uploaded for transcription.
- **Non-multimodal models**: only filenames are passed as context.

Common use cases:

- <wa-icon library="texra" name="pencil"></wa-icon> Write captions for images (`polish` agent)
- <wa-icon library="texra" name="check"></wa-icon> Verify text matches figures (`correct` agent)
- <wa-icon library="texra" name="file-text"></wa-icon> Generate text from images/PDFs (`ocr` agent)
- <wa-icon library="texra" name="unmute"></wa-icon> Transcribe audio (`transcribe_audio` agent)

For TikZ-specific workflows, see [TikZ Figures](./tikz-figures.md).
