# Working with figures

<script setup>
import MediaSectionPanel from '../.vitepress/components/MediaSectionPanel.vue';
</script>

Figures carry a lot of the evidence in theoretical work: a plot that a derivation predicts, a diagram of a construction, a page of a reference PDF. TeXRA lets agents analyze, reference, and generate figures inside your documents, from `.png` screenshots to embedded TikZ diagrams and PDFs.

::: tip CLI
This page covers attaching media in the VS Code panel. From the [`texra` CLI](./texra-cli.md),
work with a figure conversationally in `texra chat`, pass it to
`texra run` with `--input` (which takes supported media files and attaches
them), or let an agent open the figures your documents include with `read_file`. (`--context` files are read as text, so they are for `.tex`
and `.bib` sources, not images.)
:::

## <wa-icon library="texra" name="rocket"></wa-icon> Quick task: add a figure caption

1. Open a new task in the TeXRA panel.
2. Pick a vision-capable model (<wa-icon library="texra" name="robot"></wa-icon>), for example `openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5-5`, or `google/gemini-4-argon`.
3. Select **Attach** (<wa-icon library="texra" name="file-media"></wa-icon>) in the instruction box and pick your figure, or paste it.
4. Type the instruction: "Write a detailed caption for this figure."
5. Select **Start task** (<wa-icon library="texra" name="arrow-up"></wa-icon>, the arrow button at the end of the composer).

## <wa-icon library="texra" name="file-media"></wa-icon> The Media section

A chat takes media through **Attach** in the instruction box, or by pasting. A program run has a **Media** group next to Input and Context: select **Edit** on the proposal card of a program run to see it. It holds images, PDFs, and audio files for the run:

<MediaSectionPanel />

- **Add opened files as media** (<wa-icon library="texra" name="folder-opened"></wa-icon>): append every open editor tab with a supported media extension.
- **Clear all media files** (<wa-icon library="texra" name="trash"></wa-icon>): empty the media list.
- **Add media files** (<wa-icon library="texra" name="add"></wa-icon>): open a file picker to append figures, or drag and drop files directly onto the section. Drag rows to reorder them.

## <wa-icon library="texra" name="file-symlink-file"></wa-icon> Supported file types

TeXRA recognizes these media types by default:

<FeatureCards
  min="220px"
  :cards="[
    {
      icon: 'file-media',
      title: 'Images',
      desc: 'Encoded and attached for vision-capable models.',
      chips: [
        { text: '.png', variant: 'accent' },
        { text: '.jpeg', variant: 'accent' },
        { text: '.jpg', variant: 'accent' },
        { text: '.gif', variant: 'accent' },
        { text: '.heic', variant: 'accent' },
        { text: '.heif', variant: 'accent' },
        { text: '.webp', variant: 'accent' },
      ],
    },
    {
      icon: 'file-pdf',
      title: 'Documents',
      desc: 'Native PDF input on models that support it (Claude, Gemini, GPT-5.x, Muse, GLM-5V-Turbo), otherwise rasterized pages.',
      chips: [{ text: '.pdf', variant: 'info' }],
    },
    {
      icon: 'unmute',
      title: 'Audio',
      tag: 'Experimental',
      tagVariant: 'warning',
      desc: 'Uploaded for transcription by audio-capable models.',
      chips: [
        { text: '.wav', variant: 'neutral' },
        { text: '.m4a', variant: 'neutral' },
        { text: '.mp3', variant: 'neutral' },
        { text: '.aiff', variant: 'neutral' },
        { text: '.aac', variant: 'neutral' },
        { text: '.opus', variant: 'neutral' },
        { text: '.l16', variant: 'neutral' },
        { text: '.alaw', variant: 'neutral' },
        { text: '.mulaw', variant: 'neutral' },
        { text: '.ogg', variant: 'neutral' },
        { text: '.flac', variant: 'neutral' },
      ],
    },
  ]"
/>

PDFs use native multimodal support when the provider offers it; otherwise TeXRA rasterizes pages with GraphicsMagick / ImageMagick + Ghostscript (check tool detection under **Settings → LaTeX**).

## <wa-icon library="texra" name="clippy"></wa-icon> Clipboard images

Paste any copied image directly into the instruction box with `Ctrl+V` / `Cmd+V`. TeXRA saves it as `pasted_<timestamp>_<random>.<ext>`, attaches it, and cleans up temporary pasted files after 3 days.

## <wa-icon library="texra" name="wand"></wa-icon> Automatic figure extraction

A program can attach the figures of its input files itself. An agent switches this on with the `args` of its `program` call; ask for it in plain words ("attach the paper's figures"):

- `autoExtractFigure`: attaches the images that `\includegraphics` commands include.
- `autoExtractTikzFigure`: extracts `tikzpicture` environments as standalone `.tex` files, compiles them and attaches the result.
- `autoCompileInputPdf`: compiles each input file and attaches its PDF.

## <wa-icon library="texra" name="tools"></wa-icon> Figures in a chat

A chat agent has no dedicated extraction tool. It finds the figures a document includes by searching the source for `\includegraphics`, and opens each file with `read_file`, which returns an image or a PDF as an attachment a multimodal model can read. For a `tikzpicture` it compiles the picture in the shell and reads the PDF; for a citation it searches the project's `.bib` files for the key. Ask for it in plain words ("look at Figure 3 and check the caption against it").

## <wa-icon library="texra" name="eye"></wa-icon> Using media files with models

When you provide media files, they are handed to the model according to its capabilities:

- **Vision models** (GPT-5.6, Claude Fable 5.1 / Opus 5 / Sonnet 5, Gemini 3.1 Pro, …): images are encoded and attached to the prompt.
- **Audio models**: audio files are uploaded for transcription.
- **Non-multimodal models**: only filenames are passed as context.

Common use cases:

- <wa-icon library="texra" name="pencil"></wa-icon> Write captions for images (a chat agent, or the `edit` program)
- <wa-icon library="texra" name="check"></wa-icon> Verify text matches figures (the `review` or `annotate` program)
- <wa-icon library="texra" name="file-text"></wa-icon> Turn handwriting or scans into LaTeX (the `transcribe` program)
- <wa-icon library="texra" name="unmute"></wa-icon> Transcribe audio (the `transcribe` program)

For TikZ-specific workflows, read the [TikZ figures guide](./tikz-figures.md).
