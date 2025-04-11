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

## File Selection Interface

The TeXRA interface provides a streamlined way to select and manage files:

![File Selection Interface](/images/file-selection.png)

### Single File Selection

For each file category, you can select a single file using the dropdown menu. The interface provides several helpful options:

- **Current Button**: Select the currently open file in VS Code
- **Empty Button**: Clear the current selection
- **Multiple Toggle**: Switch to multiple file selection mode
- **Refresh Button** (icon): Update the file list

### Multiple File Selection

For projects requiring multiple files, enable the multiple file selection mode:

1. Click the "▼" toggle next to the file category
2. The multiple selection panel will expand
3. Use the "+" button to add files
4. Remove files with the "-" button
5. Reorder files by dragging and dropping
6. Clear the entire list using the "Empty List" button (<i class="codicon codicon-trash"></i>)

Multiple file selection is particularly useful for:

- Processing multiple chapters of a book
- Working with documents split across multiple files
- Batch processing similar documents
- Including multiple reference materials

### Adding Opened Files

The "Add Opened Files" button (<i class="codicon codicon-folder-opened"></i>) available for Input, Reference, and Auxiliary files allows you to quickly add all currently open files in your VS Code editor (that match the allowed file types) to the respective multiple file list. This is useful when you have already opened the relevant files for your project.

### Output Files

When using multiple input files, you may need to specify multiple output files:

1. Enable the "Multiple Outputs" section
2. Add output files corresponding to your input files
3. Optionally set a custom output filename

## File Path Handling

TeXRA intelligently handles file paths to ensure proper document processing:

### Relative vs. Absolute Paths

- **Display**: Files are displayed with paths relative to the workspace root
- **Processing**: TeXRA resolves paths to their absolute form when needed
- **Output**: Output files are typically saved in the same directory as their corresponding input files

### File Path Configuration

You can customize how TeXRA handles files by configuring file extensions and ignored paths in VS Code settings:

```json
"texra.files.included.inputExtensions": [
  ".txt",
  ".tex",
  ".md"
],
"texra.files.ignored.directories": [
  "build",
  "node_modules",
  "__pycache__",
  "figures",
  "venv"
],
```

## Output File Naming

TeXRA uses a structured naming convention for output files:

```
original_filename_agent_r0_model.extension
```

For example:

- Input: `paper.tex`
- Agent: `polish`
- Model: `sonnet37`
- Output: `paper_polish_r0_sonnet37.tex`

When reflection is enabled, you may also see:

- Round 1: `paper_polish_r1_sonnet37.tex`

### Custom Output Names

For specific needs, you can override the default naming:

1. Click the ">" toggle next to "Output Filename"
2. Enter your custom filename (including extension)

## File Management Commands

TeXRA provides several commands for managing generated files:

### Pack

The "Pack" button organizes output files into a structured history folder:

1. Creates a timestamped directory in the "History" folder
2. Moves all relevant output files and logs
3. Preserves the relationship between input and output files

This is useful for maintaining a clean workspace while preserving previous outputs.

### Clean

The "Clean" button removes output files for the selected agent and model:

1. Identifies all outputs for the current configuration
2. Safely removes them from the workspace
3. Leaves original input files untouched

Use this to clean up your workspace after reviewing the results.

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

If you use the LaTeX Workshop extension, configure the output directory to avoid clutter:

```json
"latex-workshop.latex.outDir": "%DIR%/build"
```

This directs LaTeX compilation output to a separate directory.

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

Now that you understand how to manage files in TeXRA, you might want to explore:

- [Tool Integration](/guide/tool-integration) - Learn how TeXRA leverages external tools
- [LaTeX Diff](/guide/latex-diff) - Understand how to compare document versions
- [Intelligent Merge](/guide/intelligent-merge) - Learn about merging edited documents
