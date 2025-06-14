# Working with Figures

TeXRA integrates seamlessly with visual and audio media, allowing AI agents to analyze, reference, or even generate figures directly within your documents. This guide covers how to manage media files (your paper's eye candy!) and leverage automatic extraction features.

## The "Media" Section in TeXRA UI

The main TeXRA panel includes a dedicated "Media" section for managing relevant files:

![Media Section UI Placeholder](/images/media-section.png)

- **Dropdown**: Select a primary media file (image, PDF, audio).
- **Multiple Files Toggle (`▼`)**: Expand to select multiple media files. Useful when an agent needs to analyze several images or audio clips.
- **Buttons**: Add (<i class="codicon codicon-add"></i>), Empty Single (<i class="codicon codicon-close"></i>), Empty List (<i class="codicon codicon-trash"></i>) work similarly to other file sections. See [File Management](./file-management.md).
- **Auto Extract Dropdown**: Configure automatic extraction of figures referenced in your LaTeX source.

## Supported File Types

TeXRA supports a range of common media types (configurable via `texra.files.included.mediaExtensions` in settings):

- **Images**: `.png`, `.jpeg`, `.jpg`, `.gif`, `.heic`, `.heif`, `.webp`
- **Documents (as images/source)**: `.pdf` (can be treated as images or potentially passed directly to models supporting native PDF)
- **Audio (Experimental)**: `.wav`, `.m4a`, `.mp3`, `.aiff`, `.aac`, `.ogg`, `.flac` (requires models with native audio support, currently primarily available via the **experimental** native Google Gemini SDK - see [Configuration](./configuration.md)).

::: info PDF Handling
TeXRA prioritizes native PDF processing for models that support it (like Anthropic/Gemini/OpenAI). If a model doesn't support native PDFs, TeXRA uses external tools (GraphicsMagick/ImageMagick and Ghostscript) as a fallback to convert PDF pages to images for analysis. See the [Installation Guide](./installation.md) for dependency details.
:::

## Quick Image Insertion via Clipboard

You can quickly add images to your TeXRA instructions by pasting directly from your clipboard:

1. **Copy any image** (screenshot, diagram, etc.) to your clipboard
2. **Paste in the instruction area** using Ctrl/Cmd+V
3. The image is automatically saved and referenced as `[pasted_timestamp_hash.ext]`
4. The Media Files section is automatically updated with the pasted image

While the clipboard accepts many image formats (JPEG, PNG, GIF, WebP, BMP, SVG, TIFF, HEIC, HEIF, AVIF, PSD), the actual formats that can be processed depend on the AI model you're using. Most vision models support common formats like JPEG, PNG, GIF, and WebP. Pasted images are stored temporarily in workspace storage and cleaned up after 3 days.

## Automatic Figure Extraction

TeXRA includes an "Auto-extract" feature to automatically identify and include figures from your input `.tex` document, reducing manual selection. This feature is accessible via the dropdown next to the Media label (<i class="codicon codicon-file-media"></i>) in the main file selection area:

1.  Click the Auto-extract toggle button (<i class="codicon codicon-wand"></i> ○<i class="codicon codicon-chevron-down"></i>) to reveal the options.
2.  Select the types of figures to extract:
    - **Figures** (<i class="codicon codicon-file-media"></i>): Extracts standard image files (`.png`, `.jpg`, `.pdf`, etc.) referenced via `\includegraphics`.
    - **TikZ Figures** (<i class="codicon codicon-file-code"></i>): Extracts code within `tikzpicture` environments.

When enabled, TeXRA parses the input `.tex` file(s) before agent execution:

- Referenced image/PDF files are added to the Media Files list.
- Detected `tikzpicture` code blocks are saved as separate `.tikz` files and added to the Media Files list.

This ensures the agent receives all relevant visual context automatically.

## Manually Selecting Figures

When you provide media files (manually or via auto-extract):

- **Vision Models:** For models like GPT-4o or Gemini, TeXRA converts images/PDF pages to a format the model can understand (usually base64 encoded data) and includes them alongside the text prompt. This allows agents to "see" the figures or document pages.
- **Audio Models (Experimental):** For models supporting native audio input (primarily via the experimental native Google SDK), TeXRA uploads the audio file and provides a reference to the model. This enables agents like `transcribe_audio`.
- **File References:** Even for non-multimodal models, the _filenames_ provided in the "Media" section can give context to the agent (e.g., "Refer to figure `diagram.pdf`").

Using the Media section effectively allows you to perform powerful tasks like:

- Asking an agent to write a caption for an image (`polish` agent).
- Having an agent verify if the text description matches a figure (`correct` agent).
- Generating text based on the content of images or PDFs (`ocr` agent or vision models).
- Creating transcriptions from audio files (`transcribe_audio` agent).

For specifics on creating and manipulating TikZ figures using the `draw` agent, please refer to the dedicated [TikZ Figures](./tikz-figures.md) guide.
