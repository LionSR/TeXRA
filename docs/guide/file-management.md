# File Management

Academic projects often involve juggling numerous files – main documents, chapters, figures, references, auxiliary styles... TeXRA aims to make this less of a circus act with its comprehensive file management system. This guide explains how to effectively organize, select, and manage files when working with TeXRA.

## File Categories

TeXRA organizes files into several categories:

### Input Files

These are the primary files that the agent will process. They typically include:

- LaTeX documents (`.tex`)
- Text files (`.txt`)
- Markdown files (`.md`)

Input files can be a single main document or multiple related files (like chapters of a book or sections of a paper).

### Reference Files

Reference files provide examples or additional context for the agent. They can be:

- Sample documents with desired formatting
- Previous versions of your work
- Published papers with similar content
- Templates or examples

### Auxiliary Files

These are supporting files needed for proper document processing:

- LaTeX class files (`.cls`)
- LaTeX style files (`.sty`)
- Bibliography files (`.bib`)
- Custom macro files
- Configuration files

### Figure & Media Files

Files containing visual or audio content, such as images, PDFs used as figures, or audio recordings. See the [Working with Figures](./working-with-figures.md) guide for details on supported types, UI controls, and automatic extraction.

#### Pasting Images from Clipboard

TeXRA supports directly pasting images from your clipboard into the instruction text area. This is useful for quickly including screenshots, diagrams, or other visual content:

1. **Copy an image** to your clipboard (e.g., take a screenshot or copy from another application)
2. **Click in the instruction text area** where you want to reference the image
3. **Paste** (Ctrl/Cmd+V) - the image will be automatically:
   - Saved to the workspace storage
   - Referenced in the text as `[pasted_timestamp_hash.ext]`
   - Added to the Media Files list
   - Made available to the AI model

The clipboard paste feature accepts many image formats (JPEG, PNG, GIF, WebP, BMP, SVG, TIFF, HEIC, HEIF, AVIF, PSD), but the actual formats that can be processed depend on what the selected AI model supports. Most vision models support common formats like JPEG, PNG, GIF, and WebP.

Note: Pasted images are stored in workspace storage and automatically cleaned up after 3 days to save space.

## File Selection Interface

The TeXRA interface provides a streamlined way to select and manage files using distinct sections for each file category (Input <wa-icon library="texra" name="file-code"></wa-icon>, Reference <wa-icon library="texra" name="book"></wa-icon>, Auxiliary <wa-icon library="texra" name="file-add"></wa-icon>, Media <wa-icon library="texra" name="file-media"></wa-icon>):

![File Selection Interface](/images/file-selection.png)

### Single File Selection

For each file category, you can select a single file using the dropdown menu. The interface provides several helpful options:

- **Current Button** (<wa-icon library="texra" name="file-code"></wa-icon>): Select the currently open file in VS Code
- **Empty Button** (<wa-icon library="texra" name="close"></wa-icon>): Clear the current selection
- **Multiple Toggle** (▼): Switch to multiple file selection mode
- **Refresh Button** (<wa-icon library="texra" name="refresh"></wa-icon> icon next to label): Update the file list

### Multiple File Selection

For projects requiring multiple files, enable the multiple file selection mode:

1. Click the "▼" toggle next to the file category
2. The multiple selection panel will expand
3. Use the "Add" button (<wa-icon library="texra" name="add"></wa-icon>) to add files via a file picker
4. Remove files with the "-" button next to each file
5. Reorder files by dragging and dropping
6. Clear the entire list using the "Empty List" button (<wa-icon library="texra" name="trash"></wa-icon>)

Multiple file selection is particularly useful for:

- Processing multiple chapters of a book
- Working with documents split across multiple files
- Batch processing similar documents
- Including multiple reference materials

### Adding Opened Files

The "Add Opened Files" button (<wa-icon library="texra" name="folder-opened"></wa-icon>) available for Input, Reference, and Auxiliary files allows you to quickly add all currently open files in your VS Code editor (that match the allowed file types) to the respective multiple file list. This is useful when you have already opened the relevant files for your project.

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

### File Path Configuration

You can customize file extensions and ignored paths in VS Code settings. The
default values are listed in the [Configuration Guide](./configuration.md). A
minimal example configuration might look like this:

```json
"texra.files.included.inputExtensions": [".tex", ".md"],
"texra.files.ignored.directories": ["build", "node_modules"]
```

## Output File Naming

TeXRA stores workflow outputs in the run's task storage folder. Within that
folder, round outputs use a simple path:

```
r{round}/output.extension
```

For example:

- Input: `paper.tex`
- Agent: `polish`
- Model: `sonnet46`
- Output: `r0/output.tex`

When the agent definition includes reflection rounds, you may also see:

- Round 1: `r1/output.tex`

## File Management Commands

TeXRA provides several commands for managing generated files, accessible from the main interface or the ProgressBoard:

### Pack

The "Pack" button (<wa-icon library="texra" name="archive"></wa-icon>) snapshots the run's task storage folder into a structured history folder:

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
<wa-icon library="texra" name="folder-opened"></wa-icon> **Open in task storage** toolbar
button. This reveals the task-run storage folder with generated files, compile
logs, mirrored LaTeX dependencies, and intermediate artifacts.

### Task Run Storage

Every workflow run gets an isolated task-run storage folder under TeXRA's
workspace storage directory:

```text
executions/<executionId>/
```

Workflow outputs are written there first, not directly over your workspace
files. Use **Accept** to copy reviewed outputs back into the workspace, **Pack**
to archive the whole run, and **Clean** to remove the run folder when you no
longer need it. The folder also stores intermediate artifacts such as optional
debug JSON files written when `texra.debug.saveDebugObjects` is enabled.

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

If you use the popular [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) extension, TeXRA attempts to automatically configure some settings upon its first activation to ensure smoother integration and cleaner project structures.
If the extension isn't installed, TeXRA will offer to install it for a smoother experience.
These defaults are applied only if the corresponding settings are not already defined:

- **Output Directory**: Sets `latex-workshop.latex.outDir` to `%DIR%/build/`. This directs LaTeX compilation output (like `.aux`, `.log`, `.pdf` files) into a `build` subdirectory within your project, keeping your main directory tidy.

  ```json
  "latex-workshop.latex.outDir": "%DIR%/build/"
  ```

- **Compilation Arguments**: Adds arguments like `-interaction=nonstopmode`, `-pdf`, and `-f` to `latex-workshop.latex.magic.args`. These help LaTeX compile more robustly, especially when run by TeXRA agents.

- **Word Wrap**: Enables word wrap specifically for `.tex` files (`[latex].editor.wordWrap`) for better readability of long lines.

These automatic configurations aim to provide a good default setup. You can always review and adjust these settings in your VS Code `settings.json` file if needed.

## Cross-Computer Syncing

For users working on multiple computers, we recommend using a cloud storage service like Dropbox to sync the following folders:

- **Log**: Contains thinking logs and other processing information
- **Diffs**: Stores difference files generated by LaTeX diff functionality
- **History**: Keeps track of different versions of your documents

To maintain your local directory structure while syncing these folders, we suggest using soft links (symbolic links). This approach allows you to store the actual folders in Dropbox while creating symbolic links in your local project directory. For example:

```bash
ln -s /path/to/Dropbox/texra-papers/ProjectName/Diffs /path/to/local/ProjectName
ln -s /path/to/Dropbox/texra-papers/ProjectName/History /path/to/local/ProjectName
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

- [Tool Integration](/guide/tool-integration) - Learn how TeXRA leverages external tools
- [LaTeX Diff](/guide/latex-diff) - Understand how to compare document versions
- [Intelligent Merge](/guide/intelligent-merge) - Learn about merging edited documents
