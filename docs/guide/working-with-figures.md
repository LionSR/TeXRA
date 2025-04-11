# Working with Figures

TeXRA integrates seamlessly with visual and audio media, allowing AI agents to analyze, reference, or even generate figures directly within your documents. This guide covers how to manage media files (your paper's eye candy!) and leverage automatic extraction features.

## The "Media" Section in TeXRA UI

The main TeXRA panel includes a dedicated "Media" section for managing relevant files:

<!-- ![Media Section UI Placeholder](/images/media-section.png) _(Placeholder: Add screenshot of the Media section)_ -->

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

## Automatic Extraction

TeXRA can automatically detect and include figures referenced in your input LaTeX file(s), saving you from manually selecting them. This is controlled by the "Auto Extract" dropdown:

![Auto Extract Options Placeholder](/images/auto-extract-options.png) _(Placeholder: Add screenshot of Auto Extract dropdown)_

- **Figures**:
  - **If checked:** TeXRA scans your LaTeX source for `\includegraphics{...}` commands.
  - It finds the referenced image files (e.g., `.png`, `.jpg`, `.pdf`).
  - These files are automatically added to the "Media" list and made available to vision-capable AI models.
  - This is useful for tasks like asking an agent to describe a figure or check consistency between text and figures.
- **TikZ Figures**:
  - **If checked:** TeXRA scans your LaTeX source for `\begin{tikzpicture}...\end{tikzpicture}` environments.
  - It extracts the TikZ code, compiles it into a preview image (e.g., PNG), and adds the preview image to the "Media" list.
  - This allows vision models to "see" the TikZ output.
  - See the [TikZ Figures](./tikz-figures.md) guide for full details on TikZ handling.

## How Media is Used by Agents

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
