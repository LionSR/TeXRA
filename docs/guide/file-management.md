<script setup>
import StorageLifecycleFlow from '../.vitepress/components/StorageLifecycleFlow.vue';
import CliStorageHero from '../.vitepress/components/CliStorageHero.vue';
</script>

# File management

This guide explains how TeXRA organizes input files, read-only context, media attachments, and run-storage outputs.

## File categories

TeXRA groups files into three categories:

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

Read the [Working with figures](./working-with-figures.md) guide for supported media formats and automatic figure extraction.

### Pasting images from the clipboard

Paste an image (`Ctrl/Cmd+V`) into the instruction box to save it to workspace storage as `[pasted_<timestamp>_<rand>.ext]` and add it to the **Media** list automatically. If the selected model does not support vision, TeXRA warns you before running. Pasted images are cleaned up after 3 days.

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

For document tasks that edit documents, output filenames are the selected input
filenames in the same order. Agents that create fixed new files declare those
names in their YAML with `task.outputs`.

## File path handling

TeXRA handles file paths as follows:

### Relative vs. absolute paths

- **Display**: Files are displayed with paths relative to the workspace root
- **Processing**: TeXRA resolves paths to their absolute form when needed
- **Output**: Document task outputs are saved in run storage. Use **Accept** or
  **Pack** when you want to copy reviewed outputs back into the workspace.

### File discovery rules

TeXRA uses built-in file extensions and exclusions when discovering inputs,
context, edited files, and media. Read the [file discovery section of the configuration guide](./configuration.md#file-discovery).

## Output file naming

TeXRA stores document task outputs in the run folder under run storage. Within
that folder, the revised document keeps your input filename in every revision
(the first revision in `r0/`, the second in `r1/`, and so on):

```
r{round}/<input-filename>
```

Subdirectories are preserved, so `chapters/intro.tex` lands at
`r0/chapters/intro.tex`. The only fixed name is the raw model response,
`r{round}/output.xml`.

For example:

- Input: `paper.tex`
- Agent: `polish`
- Model: `anthropic/claude-sonnet-5-5`
- Output: `r0/paper.tex`

When the agent's task has a second (reflection) revision, you may also see:

- Revision 2: `r1/paper.tex`

## File management commands

TeXRA provides several commands for managing generated files, available from the main interface or the ProgressBoard:

### Pack

The "Pack" button (<wa-icon library="texra" name="box-archive"></wa-icon>) snapshots the run folder into a structured history folder:

1. Creates a timestamped directory in the "History" folder
2. Copies all relevant output files, logs, and mirrored dependencies
3. Preserves the relationship between input and output files

Use this to keep a clean workspace while preserving previous outputs.

### Clean

The "Clean" button (<wa-icon library="texra" name="trash"></wa-icon>) removes output files for the selected run:

1. Identifies the run folder for the current run
2. Removes generated artifacts from the run folder
3. Leaves original input files untouched

Use this to remove generated artifacts from run storage after reviewing the results.

### Opening generated files

Document task outputs are listed in the ProgressBoard under **Generated Files**.
Select a file name to preview it in VS Code. Files open using VS Code's default
viewer, so PDFs and images display correctly while `.tex` documents open in the
editor.

To browse the whole run folder, use the
<wa-icon library="texra" name="folder-open"></wa-icon> **Open in run storage** toolbar
button. This reveals the run folder with generated files, compile
logs, mirrored LaTeX dependencies, and intermediate artifacts. (From a
terminal, `texra history show <id>` lists the same stored artifacts; see the
card below.)

### Run storage

Every run gets an isolated run folder under TeXRA's
workspace storage directory:

```text
executions/<executionId>/
```

Document task outputs are written there first, not directly over your workspace
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

### LaTeX Workshop integration

If a LaTeX workspace does not have the
[LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop)
extension installed, TeXRA offers to install it. TeXRA does not rewrite editor
or LaTeX Workshop preferences during startup. Use TeXRA's LaTeX settings page
to inspect and apply the available workspace recommendations explicitly.

## Cross-computer syncing

If you work on several computers, you can sync the **History** folder (which holds packed document versions) via a cloud storage folder using a symlink:

```bash
ln -s /path/to/Dropbox/texra-projects/ProjectName/History /path/to/local/ProjectName/History
```

## Next steps

- [Research tools](/guide/research-tools): how TeXRA uses external tools
- [LaTeX Diff](/guide/latex-diff): how to compare document versions
- [Intelligent Merge](/guide/intelligent-merge): how edited documents are merged
