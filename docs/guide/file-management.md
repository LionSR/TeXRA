<script setup>
import StorageLifecycleFlow from '../.vitepress/components/StorageLifecycleFlow.vue';
import CliStorageHero from '../.vitepress/components/CliStorageHero.vue';
</script>

# File management

A research project involves many files: the manuscript, chapters and appendices with derivations, figures, references, notes, auxiliary styles. This guide explains how to organize, select, and manage files when working with TeXRA.

## File categories

TeXRA organizes files into three categories, each with its own accepted file types and read/write role:

<FeatureCards
  min="220px"
  :cards="[
    {
      icon: 'file-code',
      title: 'Input',
      tag: 'Read + edit',
      tagVariant: 'success',
      desc: 'Primary documents the agent reads and rewrites.',
      chips: [
        { text: '.tex', variant: 'accent' },
        { text: '.txt', variant: 'accent' },
        { text: '.md', variant: 'accent' },
      ],
    },
    {
      icon: 'book',
      title: 'Context',
      tag: 'Read-only',
      tagVariant: 'info',
      desc: 'Reference material the agent sees but never modifies.',
      chips: [
        { text: '.bib', variant: 'info' },
        { text: '.bbl', variant: 'info' },
        { text: '.sty', variant: 'info' },
        { text: '.cls', variant: 'info' },
        { text: 'reference papers', variant: 'neutral' },
      ],
    },
    {
      icon: 'video',
      title: 'Media',
      tag: 'Visual / audio',
      tagVariant: 'neutral',
      desc: 'Figures and recordings handed to vision/audio models.',
      chips: [
        { text: 'images', variant: 'neutral' },
        { text: 'PDF figures', variant: 'neutral' },
        { text: 'audio', variant: 'neutral' },
      ],
    },
  ]"
/>

<p class="hero-caption">Three categories: Input is read + edited, Context is read-only, Media carries visual and audio content.</p>

### Input files

These are the primary files the agent reads and edits. They typically include:

- LaTeX documents (`.tex`)
- Text files (`.txt`)
- Markdown files (`.md`)

Input files can be a single main document or several related files (such as chapters of a book or sections of a paper).

### Context files

Read-only files the agent sees but does not modify. They can be:

- Bibliographies (`.bib`/`.bbl`)
- Style and macro files (`.sty`/`.cls`)
- Reference papers or previous versions
- Any document the output should match for formatting

### Figure & media files

Files containing visual or audio content, such as images, PDFs used as figures, or audio recordings. Read the [Working with figures](./working-with-figures.md) guide for supported types, UI controls, and automatic extraction.

#### Pasting images from clipboard

You can paste images from your clipboard directly into the instruction text area. This is useful for including screenshots, diagrams, or other visual content:

1. **Copy an image** to your clipboard (for example, take a screenshot or copy from another application)
2. **Place the cursor in the instruction text area** where you want to reference the image
3. **Paste** (Ctrl/Cmd+V). The image is then:
   - Saved to the workspace storage
   - Referenced in the text as `[pasted_<timestamp>_<rand>.ext]`
   - Added to the Media Files list
   - Made available to the AI model

Pasted images appear in the file selector like any other media file, so you can review or remove them before sending. If the selected model cannot read images, TeXRA warns you so you can switch to a vision-capable model.

Clipboard paste accepts many image formats (JPEG, PNG, GIF, WebP, BMP, SVG, TIFF, HEIC, HEIF, AVIF, PSD), but the formats that can be processed depend on what the selected AI model supports. Most vision models support common formats like JPEG, PNG, GIF, and WebP.

Note: Pasted images are stored in workspace storage and removed automatically after 3 days to save space.

## File selection interface

The TeXRA interface has a section for each file category (Input <wa-icon library="texra" name="file-code"></wa-icon>, Context <wa-icon library="texra" name="book"></wa-icon>, Media <wa-icon library="texra" name="video"></wa-icon>):

<FileSelectHero />

<p class="hero-caption">Each category holds an ordered list of files with three quick actions in the header.</p>

### File list controls

Each category (Input, Context, and Media) manages a list of files; a single-file workflow is a list of length one. The header has three buttons:

- **Add opened files** (<wa-icon library="texra" name="folder-open"></wa-icon>): Append every editor tab whose extension matches the category to the list.
- **Clear all files** (<wa-icon library="texra" name="trash"></wa-icon>): Empty the list.
- **Add files** (<wa-icon library="texra" name="plus"></wa-icon>): Open a file picker to append files.

You can also **drag and drop files** from the OS file manager (or from VS Code's Explorer) onto a category to add them.

Inside the list:

- Each file row has a small trash icon to remove that file.
- Drag a row to reorder files. Input files are sent to the agent in this order.

The list is the only mode; there is no separate "single file" view. To work with one file, keep the list at length one.

This works well for:

- Processing several chapters of a book
- Working with documents split across several files
- Batch processing similar documents
- Including several reference materials

### Output files

For workflow agents that edit documents, output filenames are the selected input
filenames in the same order. Agents that create fixed new files declare those
names in their YAML with `settings.defaultOutputFiles`.

## File path handling

TeXRA handles file paths as follows:

### Relative vs. absolute paths

- **Display**: Files are displayed with paths relative to the workspace root
- **Processing**: TeXRA resolves paths to their absolute form when needed
- **Output**: Workflow outputs are saved in task storage. Use **Accept** or
  **Pack** when you want to copy reviewed outputs back into the workspace.

### File discovery rules

TeXRA uses built-in file extensions and exclusions when discovering inputs,
context, edited files, and media. The former `texra.files.*` configuration keys
have been removed. Read the [file discovery section of the configuration guide](./configuration.md#file-discovery).

## Output file naming

TeXRA stores workflow outputs in the run's task storage folder. Within that
folder, the revised document keeps your input filename in every round:

```
r{round}/<input-filename>
```

Subdirectories are preserved, so `chapters/intro.tex` lands at
`r0/chapters/intro.tex`. The only fixed name is the raw model response,
`r{round}/output.xml`.

For example:

- Input: `paper.tex`
- Agent: `polish`
- Model: `sonnet5`
- Output: `r0/paper.tex`

When the agent definition includes reflection rounds, you may also see:

- Round 1: `r1/paper.tex`

## File management commands

TeXRA provides several commands for managing generated files, available from the main interface or the ProgressBoard:

### Pack

The "Pack" button (<wa-icon library="texra" name="box-archive"></wa-icon>) snapshots the run's task storage folder into a structured history folder:

1. Creates a timestamped directory in the "History" folder
2. Copies all relevant output files, logs, and mirrored dependencies
3. Preserves the relationship between input and output files

Use this to keep a clean workspace while preserving previous outputs.

### Clean

The "Clean" button (<wa-icon library="texra" name="trash"></wa-icon>) removes output files for the selected run:

1. Identifies the task storage folder for the current run
2. Removes generated artifacts from task storage
3. Leaves original input files untouched

Use this to remove generated artifacts from task storage after reviewing the results.

### Opening generated files

Workflow outputs are listed in the ProgressBoard under **Generated Files**.
Select a file name to preview it in VS Code. Files open using VS Code's default
viewer, so PDFs and images display correctly while `.tex` documents open in the
editor.

To browse the whole run folder, use the
<wa-icon library="texra" name="folder-open"></wa-icon> **Open in task storage** toolbar
button. This reveals the task storage folder with generated files, compile
logs, mirrored LaTeX dependencies, and intermediate artifacts. (From a
terminal, `texra history show <id>` lists the same stored artifacts; see the
card below.)

### Task run storage

Every workflow run gets an isolated task storage folder under TeXRA's
workspace storage directory:

```text
executions/<executionId>/
```

Workflow outputs are written there first, not directly over your workspace
files. Three commands then move that run's artifacts to three different places:

<StorageLifecycleFlow />

<p class="hero-caption">Accept copies reviewed outputs into the workspace, Pack archives the run into History, and Clean deletes the run folder. Your input files are never touched.</p>

The CLI follows the same storage-first lifecycle: it reads and writes the
same `executions/<executionId>/` run store, and `--output` plays the role of
**Accept**:

<CliStorageHero />

<p class="hero-caption">Three beats of the same lifecycle: storage-first output, <code>--output</code> as Accept, and <code>history show</code> to browse a run's stored files.</p>

The folder also stores intermediate artifacts such as optional
debug JSON files written when `texra.debug.saveModelIO` is enabled.

## Working with LaTeX projects

For LaTeX projects with many files and dependencies:

### LaTeX directory structure

TeXRA works well with standard LaTeX project structures:

```
project/
├── main.tex            # Main document
├── chapters/           # Chapter files
│   ├── intro.tex       # Introduction
│   └── methodology.tex # Methodology
├── figures/            # Figure directory
│   ├── diagram.pdf     # Figure file
│   └── graph.png       # Another figure
└── bibliography.bib    # Bibliography
```

### Input file detection

TeXRA detects appropriate input files based on:

1. File extension (`.tex`, `.txt`, `.md`)
2. Location in project hierarchy
3. Content structure

### LaTeX Workshop integration

If a LaTeX workspace does not have the
[LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop)
extension installed, TeXRA offers to install it. TeXRA does not rewrite editor
or LaTeX Workshop preferences during startup. Use TeXRA's LaTeX settings page
to inspect and apply the available workspace recommendations explicitly.

## Cross-computer syncing

If you work on several computers, use a cloud storage service like Dropbox to sync the **History** folder, which holds packed versions of your documents.

To keep your local directory structure while syncing this folder, use symbolic links. Store the actual folder in Dropbox and create a symbolic link in your local project directory. For example:

```bash
ln -s /path/to/Dropbox/texra-papers/ProjectName/History /path/to/local/ProjectName/History
```

Replace `/path/to/Dropbox` and `/path/to/local` with your actual Dropbox and local project paths.

## Best practices

### Organizing input files

- **Main document first**: When using several input files, list the main document first
- **Logical order**: Arrange chapter files in reading order
- **Consistency**: Keep file naming conventions consistent

### Managing output files

- **Regular cleanup**: Use the "Clean" command to remove unneeded outputs
- **Version control**: Use "Pack" to preserve important milestones
- **Diff review**: Use LaTeXdiff to review changes before accepting them

### Reference materials

- **Relevant examples**: Include only directly relevant reference files
- **Context limits**: Keep model context limits in mind when adding references
- **Format consistency**: Use reference materials with similar formatting styles

## Next steps

Now that you know how to manage files in TeXRA, you may want to read about:

- [Research tools](/guide/research-tools): how TeXRA uses external tools
- [LaTeX Diff](/guide/latex-diff): how to compare document versions
- [Intelligent Merge](/guide/intelligent-merge): how edited documents are merged
