<script setup>
import StorageLifecycleFlow from '../.vitepress/components/StorageLifecycleFlow.vue';
import CliStorageHero from '../.vitepress/components/CliStorageHero.vue';
</script>

# File Management

Academic projects often involve juggling numerous files – main documents, chapters, figures, references, auxiliary styles... TeXRA aims to make this less of a circus act with its comprehensive file management system. This guide explains how to effectively organize, select, and manage files when working with TeXRA.

## File Categories

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

### Input Files

These are the primary files the agent reads and edits. They typically include:

- LaTeX documents (`.tex`)
- Text files (`.txt`)
- Markdown files (`.md`)

Input files can be a single main document or multiple related files (like chapters of a book or sections of a paper).

### Context Files

Read-only files the agent sees but won't modify. They can be:

- Bibliographies (`.bib`/`.bbl`)
- Style and macro files (`.sty`/`.cls`)
- Reference papers or previous versions
- Any document the output should match for formatting

### Figure & Media Files

Files containing visual or audio content, such as images, PDFs used as figures, or audio recordings. See the [Working with Figures](./working-with-figures.md) guide for details on supported types, UI controls, and automatic extraction.

#### Pasting Images from Clipboard

TeXRA supports directly pasting images from your clipboard into the instruction text area. This is useful for quickly including screenshots, diagrams, or other visual content:

1. **Copy an image** to your clipboard (e.g., take a screenshot or copy from another application)
2. **Click in the instruction text area** where you want to reference the image
3. **Paste** (Ctrl/Cmd+V) - the image will be automatically:
   - Saved to the workspace storage
   - Referenced in the text as `[pasted_<timestamp>_<rand>.ext]`
   - Added to the Media Files list
   - Made available to the AI model

Pasted images appear in the file selector like any other media file, so you can review or remove them before sending. If the selected model cannot read images, TeXRA warns you so you can switch to a vision-capable model.

The clipboard paste feature accepts many image formats (JPEG, PNG, GIF, WebP, BMP, SVG, TIFF, HEIC, HEIF, AVIF, PSD), but the actual formats that can be processed depend on what the selected AI model supports. Most vision models support common formats like JPEG, PNG, GIF, and WebP.

Note: Pasted images are stored in workspace storage and automatically cleaned up after 3 days to save space.

## File Selection Interface

The TeXRA interface provides a streamlined way to select and manage files using distinct sections for each file category (Input <wa-icon library="texra" name="file-code"></wa-icon>, Context <wa-icon library="texra" name="book"></wa-icon>, Media <wa-icon library="texra" name="video"></wa-icon>):

<FileSelectHero />

<p class="hero-caption">Each category holds an ordered list of files with three quick actions in the header.</p>

### File List Controls

Each category — Input, Context, and Media — manages a list of files (a single-file workflow is just a list of length one). The header exposes three buttons:

- **Add opened files** (<wa-icon library="texra" name="folder-open"></wa-icon>): Append every editor tab whose extension matches the category to the list.
- **Clear all files** (<wa-icon library="texra" name="trash"></wa-icon>): Empty the list.
- **Add files** (<wa-icon library="texra" name="plus"></wa-icon>): Open a file picker to append files.

You can also **drag-and-drop files** from the OS file manager (or from VS Code's Explorer) onto a category to add them.

Inside the list:

- Each file row has a small trash icon to remove just that file.
- Drag a row to reorder files. Input files are sent to the agent in this order.

The list is the only mode — there is no separate "single file" view. To work with one file, just keep the list at length one.

This works well for:

- Processing multiple chapters of a book
- Working with documents split across multiple files
- Batch processing similar documents
- Including multiple reference materials

### Output Files

For workflow agents that edit documents, output filenames are the selected input
filenames in the same order. Agents that create fixed new files declare those
names in their YAML with `settings.defaultOutputFiles`.

## File Path Handling

TeXRA intelligently handles file paths to ensure proper document processing:

### Relative vs. Absolute Paths

- **Display**: Files are displayed with paths relative to the workspace root
- **Processing**: TeXRA resolves paths to their absolute form when needed
- **Output**: Workflow outputs are saved in task storage. Use **Accept** or
  **Pack** when you want to copy reviewed outputs back into the workspace.

### File Discovery Rules

TeXRA uses built-in file extensions and exclusions when discovering inputs,
context, edited files, and media. The former `texra.files.*` configuration keys
have been removed. See the [Configuration Guide](./configuration.md#file-discovery).

## Output File Naming

TeXRA stores workflow outputs in the run's task storage folder. Within that
folder, round outputs use a simple path:

```
r{round}/output.extension
```

For example:

- Input: `paper.tex`
- Agent: `polish`
- Model: `sonnet5`
- Output: `r0/paper.tex`

When the agent definition includes reflection rounds, you may also see:

- Round 1: `r1/output.tex`

## File Management Commands

TeXRA provides several commands for managing generated files, accessible from the main interface or the ProgressBoard:

### Pack

The "Pack" button (<wa-icon library="texra" name="box-archive"></wa-icon>) snapshots the run's task storage folder into a structured history folder:

1. Creates a timestamped directory in the "History" folder
2. Copies all relevant output files, logs, and mirrored dependencies
3. Preserves the relationship between input and output files

This is useful for maintaining a clean workspace while preserving previous outputs.

### Clean

The "Clean" button (<wa-icon library="texra" name="trash"></wa-icon>) removes output files for the selected run:

1. Identifies the task storage folder for the current run
2. Safely removes generated artifacts from task storage
3. Leaves original input files untouched

Use this to remove generated artifacts from task-run storage after reviewing the results.

### Opening Generated Files

Workflow outputs are listed in the ProgressBoard under **Generated Files**.
Click a file name to preview it in VS Code. Files open using VS Code's default
viewer, so PDFs and images display correctly while `.tex` documents open in the
editor.

To browse the whole run folder, use the
<wa-icon library="texra" name="folder-open"></wa-icon> **Open in task storage** toolbar
button. This reveals the task-run storage folder with generated files, compile
logs, mirrored LaTeX dependencies, and intermediate artifacts. (From a
terminal, `texra history show <id>` lists the same stored artifacts — see the
card below.)

### Task Run Storage

Every workflow run gets an isolated task-run storage folder under TeXRA's
workspace storage directory:

```text
executions/<executionId>/
```

Workflow outputs are written there first, not directly over your workspace
files. Three commands then move that run's artifacts to three different places:

<StorageLifecycleFlow />

<p class="hero-caption">Accept copies reviewed outputs into the workspace, Pack archives the run into History, and Clean deletes the run folder — your input files are never touched.</p>

The CLI follows the same storage-first lifecycle — it reads and writes the
same `executions/<executionId>/` run store, and `--output` plays the role of
**Accept**:

<CliStorageHero />

<p class="hero-caption">Three beats of the same lifecycle: storage-first output, <code>--output</code> as Accept, and <code>history show</code> to browse a run's stored files.</p>

The folder also stores intermediate artifacts such as optional
debug JSON files written when `texra.debug.saveModelIO` is enabled.

## Working with LaTeX Projects

For complex LaTeX projects with many files and dependencies:

### LaTeX Directory Structure

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

### Input File Detection

TeXRA automatically detects appropriate input files based on:

1. File extension (`.tex`, `.txt`, `.md`)
2. Location in project hierarchy
3. Content structure

### LaTeX Workshop Integration

If a LaTeX workspace does not have the popular
[LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop)
extension installed, TeXRA offers to install it. TeXRA does not rewrite editor
or LaTeX Workshop preferences during startup. Use TeXRA's LaTeX settings page
to inspect and apply the available workspace recommendations explicitly.

## Cross-Computer Syncing

For users working on multiple computers, we recommend using a cloud storage service like Dropbox to sync the **History** folder, which keeps track of packed versions of your documents.

To maintain your local directory structure while syncing this folder, we suggest using soft links (symbolic links). This approach allows you to store the actual folder in Dropbox while creating a symbolic link in your local project directory. For example:

```bash
ln -s /path/to/Dropbox/texra-papers/ProjectName/History /path/to/local/ProjectName/History
```

Replace `/path/to/Dropbox` and `/path/to/local` with your actual Dropbox and local project paths.

## Best Practices

### Organizing Input Files

- **Main Document First**: When using multiple input files, list the main document first
- **Logical Order**: Arrange chapter files in logical reading order
- **Consistency**: Maintain consistent file naming conventions

### Managing Output Files

- **Regular Cleanup**: Use the "Clean" command to remove unnecessary outputs
- **Version Control**: Use "Pack" to preserve important milestones
- **Diff Review**: Use LaTeXdiff to review changes before accepting them

### Reference Materials

- **Relevant Examples**: Include only directly relevant reference files
- **Context Limits**: Be mindful of model context limits when adding references
- **Format Consistency**: Use reference materials with similar formatting styles

## Next Steps

Now that you understand how to manage files in TeXRA, you might want to learn about:

- [Research Tools](/guide/research-tools) - Learn how TeXRA leverages external tools
- [LaTeX Diff](/guide/latex-diff) - Understand how to compare document versions
- [Intelligent Merge](/guide/intelligent-merge) - Learn about merging edited documents
