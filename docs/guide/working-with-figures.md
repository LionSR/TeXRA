# Working with Figures

TeXRA allows AI agents to analyze, reference, and generate figures within your documents.

## Quick Task: Add a Figure Caption

1. Select the `polish` agent from the dropdown
2. Choose a vision-capable model (e.g., `gemini25p`, `gpt4o`)
3. Select your figure in the **Media** section
4. Enter instruction: "Write a detailed caption for this figure"
5. Click Execute

## The Media Section

The main TeXRA panel includes a "Media" section for managing figure files:

- **Dropdown**: Select a primary media file
- **Multiple Toggle**: Expand to select multiple files
- **Auto Extract Dropdown**: Configure automatic figure extraction

## Supported File Types

Configurable via `texra.files.included.mediaExtensions`:

- **Images**: `.png`, `.jpeg`, `.jpg`, `.gif`, `.heic`, `.heif`, `.webp`
- **Documents**: `.pdf` (native or converted to images)
- **Audio** (experimental): `.wav`, `.m4a`, `.mp3`, `.aiff`, `.aac`, `.ogg`, `.flac`

PDFs are processed natively when supported (Anthropic/Gemini/OpenAI). Otherwise, TeXRA uses GraphicsMagick/ImageMagick + Ghostscript for conversion.

## Clipboard Images

Paste images directly into the instruction area:

1. Copy any image to clipboard
2. Paste with Ctrl/Cmd+V
3. Image is saved and referenced as `[pasted_timestamp_hash.ext]`
4. Media Files list updates automatically

Pasted images are stored temporarily and cleaned up after 3 days.

## Automatic Figure Extraction

Enable via the Auto-extract dropdown near the Media label:

- **Figures**: Extracts images from `\includegraphics` commands
- **TikZ Figures**: Extracts `tikzpicture` environments as `.tikz` files

## Figure Extraction Tools

Tool-use agents can extract figures programmatically:

### `extract_figures`

Scans for `\includegraphics` and returns referenced files (max 20 attachments):

```json
{
  "name": "extract_figures",
  "arguments": { "texPath": "paper/main.tex" }
}
```

### `extract_tikz_figures`

Extracts and optionally compiles TikZ environments (max 12 PDFs):

```json
{
  "name": "extract_tikz_figures",
  "arguments": { "texPath": "paper/main.tex", "compile": true }
}
```

### `extract_bib_entries`

Retrieves BibTeX records for citations.

## Using Media Files

When you provide media files:

- **Vision models** (GPT-4o, Gemini): Images are encoded and included with the prompt
- **Audio models**: Audio files are uploaded for transcription
- **Non-multimodal models**: Filenames provide context

Common use cases:
- Write captions for images (`polish` agent)
- Verify text matches figures (`correct` agent)
- Generate text from images/PDFs (`ocr` agent)
- Transcribe audio (`transcribe_audio` agent)

For TikZ-specific workflows, see [TikZ Figures](./tikz-figures.md).
