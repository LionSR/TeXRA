# Working with Figures

<script setup>
import MediaSectionPanel from '../.vitepress/components/MediaSectionPanel.vue';
import AutoExtractMenu from '../.vitepress/components/AutoExtractMenu.vue';
</script>

TeXRA lets AI agents analyse, reference, and generate figures inside your documents — from `.png` screenshots to embedded TikZ diagrams and PDFs.

::: tip CLI
This page covers the VS Code **Media** selector. From the [`texra` CLI](./texra-cli.md),
work with a figure conversationally in `texra chat`, or let a tool-use agent
pull figures out of your documents with the built-in extraction tools.
(`--context` files are read as text, so they're for `.tex` and
`.bib` sources, not images.)
:::

## <wa-icon library="texra" name="rocket"></wa-icon> Quick Task: Add a Figure Caption

1. Select the `polish` agent from the agent dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>).
2. Pick a vision-capable model (<wa-icon library="texra" name="robot"></wa-icon>) — e.g. `gpt56`, `sonnet5T`, `gemini31p`.
3. Select your figure in the **Media** (<wa-icon library="texra" name="file-media"></wa-icon>) section.
4. Type the instruction: "Write a detailed caption for this figure."
5. Click Execute (<wa-icon library="texra" name="play"></wa-icon>).

## <wa-icon library="texra" name="file-media"></wa-icon> The Media Section

The main TeXRA panel includes a **Media** section for figure files. Its header carries the inline **Auto Extract** dropdown (<wa-icon library="texra" name="wand"></wa-icon>) plus a three-action toolbar, and each file is a row you can drag to reorder:

<MediaSectionPanel />

<p class="hero-caption">The Media group: the wand opens auto-extract options, the toolbar adds opened files / clears all / adds media files, and each row drags to reorder with a trailing trash icon.</p>

- **Auto Extract Dropdown** (<wa-icon library="texra" name="wand"></wa-icon>): configure automatic figure extraction.
- **Add opened files** (<wa-icon library="texra" name="folder-opened"></wa-icon>): append every open editor tab whose extension is a supported media type.
- **Clear all media files** (<wa-icon library="texra" name="trash"></wa-icon>): empty the media list.
- **Add media files** (<wa-icon library="texra" name="add"></wa-icon>): open a file picker to append figures.
- **Drag-and-drop** image, PDF, or audio files from anywhere onto the section.

## <wa-icon library="texra" name="file-symlink-file"></wa-icon> Supported File Types

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
      desc: 'Native multimodal on Anthropic / Gemini / OpenAI, otherwise rasterised.',
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
        { text: '.ogg', variant: 'neutral' },
        { text: '.flac', variant: 'neutral' },
      ],
    },
  ]"
/>

<p class="hero-caption">Three media categories with their accepted extensions — images and audio carry several formats, while PDFs lean on native multimodal support where the provider offers it.</p>

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

<AutoExtractMenu />

<p class="hero-caption">The lit wand button opens a checkbox menu — toggle Figures, TikZ Figures, and Compile Input PDF.</p>

- **Figures** (<wa-icon library="texra" name="file-media"></wa-icon>): extracts images from `\includegraphics` commands.
- **TikZ Figures** (<wa-icon library="texra" name="symbol-structure"></wa-icon>): extracts `tikzpicture` environments as `.tikz` files and compiles them.

## <wa-icon library="texra" name="tools"></wa-icon> Figure Extraction Tools

Tool-use agents can extract figures programmatically. These are part of the **LaTeX Extraction** built-in tool group — always available. In a run, an agent like `research` drives them one after another, attaching what it finds so a multimodal model can read it:

<ToolCallPanel
  title="research"
  icon="sparkle"
  caption="gathering a paper's figures · LaTeX Extraction · this run"
  :calls="[
    { state: 'done', verb: 'extract_figures', target: 'paper/main.tex', effect: 'Found 9 \\includegraphics — attached 9 files' },
    { state: 'done', verb: 'extract_bib_entries', target: 'paper/main.tex', effect: 'Returned BibTeX for every \\cite key' },
    { state: 'active', verb: 'extract_tikz_figures', target: 'paper/main.tex', effect: 'compile: true → latexmk renders 7 tikzpicture snippets, attaches 7 PDFs' },
  ]"
/>

<p class="hero-caption">The three LaTeX Extraction tools as they surface in the Progress view — each returns referenced files, BibTeX records, or compiled TikZ PDFs the model can read directly. The raw request form for each is below.</p>

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

- **Vision models** (GPT-5.5, Claude Opus 5 / Sonnet 4.6, Gemini 3.1 Pro, …): images are encoded and attached to the prompt.
- **Audio models**: audio files are uploaded for transcription.
- **Non-multimodal models**: only filenames are passed as context.

Common use cases:

- <wa-icon library="texra" name="pencil"></wa-icon> Write captions for images (`polish` agent)
- <wa-icon library="texra" name="check"></wa-icon> Verify text matches figures (`correct` agent)
- <wa-icon library="texra" name="file-text"></wa-icon> Generate text from images/PDFs (`ocr` agent)
- <wa-icon library="texra" name="unmute"></wa-icon> Transcribe audio (`transcribe_audio` agent)

For TikZ-specific workflows, see [TikZ Figures](./tikz-figures.md).
