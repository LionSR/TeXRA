# LaTeX Diff

CoAuthor provides powerful LaTeX diff functionality to help you compare different versions of your documents. This feature is essential for tracking changes, collaborating with co-authors, and reviewing AI-generated modifications.

## Understanding LaTeX Diff

Unlike standard text diff tools, LaTeX diff understands LaTeX syntax and produces readable, compilable LaTeX documents with changes highlighted. This approach offers several advantages:

1. **Structural Awareness**: Understands LaTeX environments and commands
2. **Visual Clarity**: Shows changes within the typeset document
3. **Compilable Output**: Produces valid LaTeX documents that can be compiled
4. **Academic Focus**: Optimized for scholarly documents with equations, figures, and citations

## The LaTeXdiffs Section

The LaTeX diff functionality is accessible through the "LaTeXdiffs" section in the CoAuthor interface:

<!-- ![LaTeXdiffs Section](/images/latexdiffs-section.png) -->

This section provides several key features:

1. **Base File Selection**: Choose an original/base document
2. **Edited File Selection**: Select a modified version
3. **latexdiff Button**: Generate a diff between two files
4. **Git Integration**: Compare with previous versions using Git history
5. **Merge Button**: Intelligently merge changes from edited file to base file

## Basic File Comparison

To compare two LaTeX files:

### Step 1: Select Files

1. In the "Base File" dropdown, select the original version
2. In the "Edited File" dropdown, select the modified version

::: tip
The "Current" button allows you to quickly select the currently open file for either role.
:::

### Step 2: Generate the Diff

Click the "latexdiff" button with the <i class="codicon codicon-diff-single"></i> icon.

CoAuthor will:
1. Run the latexdiff tool on your selected files
2. Generate a new LaTeX document with highlighted changes
3. Open the diff document for review

### Step 3: Review Changes

The generated diff document will highlight:
- **Additions**: Usually in blue or underlined
- **Deletions**: Usually in red or struck through
- **Changes**: Shown as deletions followed by additions

<!-- ![LaTeX Diff Example](/images/latex-diff-example.png) -->

## Git-Based Version Comparison

CoAuthor also allows you to compare documents with previous Git versions:

### Step 1: Select Base File and Commit

1. Select a base file (typically your current working file)
2. Choose a Git commit from the "Commit" dropdown

::: info
The commit dropdown shows recent commits. Click the refresh icon to update the list.
:::

### Step 2: Generate the Diff

Click the "latexdiff-vc" button to compare your file with its version at the selected commit.

### Step 3: Manage Diff Outputs

After generating a Git-based diff, you can:
- **Pack**: Archive the diff files using the "Pack" button
- **Clean**: Remove the diff files using the "Clean" button

## Understanding Diff Output

The diff document uses a specialized markup to highlight changes:

### Default Markup

By default, latexdiff uses the following markup:

- **Additions**: `\DIFadd{Added text}`
- **Deletions**: `\DIFdel{Deleted text}`

These commands are defined in the preamble of the generated document and typically render as:
- Additions: <span style="color: blue; text-decoration: underline;">Blue underlined text</span>
- Deletions: <span style="color: red; text-decoration: line-through;">Red struck-through text</span>

### Interpreting Complex Changes

For complex LaTeX structures, understanding the diff may require attention to:

1. **Math Environments**: Changes in equations may be marked differently
2. **Nested Environments**: Changes within nested environments can be complex
3. **Command Arguments**: Changes to command arguments are marked specially
4. **Whitespace Changes**: May or may not be highlighted depending on settings

## Advanced Diff Usage

### Comparing Multiple Files

For documents split across multiple files:

1. Use the `merge` agent instead of the basic diff functionality
2. Select the base directory containing all files
3. Provide specific instructions for handling multiple files

### Filtering Changes

To focus on specific types of changes:

1. After generating a diff, you can search for `\DIFadd` or `\DIFdel` commands
2. Use VS Code's search functionality to navigate between changes
3. Consider creating custom search patterns for specific types of changes

### Customizing Diff Appearance

The appearance of diffs can be customized by adding commands to your document:

```latex
% Add to preamble of your document to customize diff appearance
\providecommand{\DIFadd}[1]{{\color{blue}\textbf{#1}}}
\providecommand{\DIFdel}[1]{{\color{red}\textit{#1}}}
```

## Integration with Workflow

LaTeX diff integrates with several CoAuthor workflows:

### Document Review Workflow

1. Generate initial document using appropriate agent
2. Make manual edits or use another agent for revision
3. Use latexdiff to compare original and revised versions
4. Review and accept/reject changes
5. Use merge functionality to create final version

### Collaborative Editing Workflow

1. Share base document with collaborators
2. Receive edited versions back
3. Use latexdiff to visualize each contributor's changes
4. Use merge to selectively incorporate changes
5. Generate diffs of the merged document for confirmation

### Version Control Workflow

1. Commit document versions regularly to Git
2. Use latexdiff-vc to compare with previous versions
3. Track evolution of document over time
4. Identify when specific changes were made
5. Recover and merge content from previous versions as needed

## Under the Hood

CoAuthor's LaTeX diff functionality builds on several key technologies:

### latexdiff Tool

[latexdiff](https://ctan.org/pkg/latexdiff) is a Perl script that compares LaTeX files and generates a marked-up LaTeX document highlighting differences.

CoAuthor:
1. Calls latexdiff with appropriate options
2. Processes the output for consistency
3. Applies additional formatting as needed

### latexdiff-vc

[latexdiff-vc](https://ctan.org/pkg/latexdiff) (version control) extends latexdiff to work with version control systems like Git.

CoAuthor:
1. Retrieves file versions from Git history
2. Passes them to latexdiff
3. Manages the output files

### Merge Process

The intelligent merge process:
1. Analyzes both documents semantically
2. Identifies substantive changes
3. Creates a new document combining the best elements
4. Optionally generates a diff showing applied changes

## Troubleshooting

### Common Diff Issues

**Problem**: Missing or incomplete highlights

**Solutions**:
- Ensure both documents are valid LaTeX
- Check for complex structures that might confuse latexdiff
- Try comparing smaller sections of the document

**Problem**: Diff document doesn't compile

**Solutions**:
- Look for conflicting markup in preamble
- Check for unclosed environments or commands
- Remove complex custom commands that might interfere with diff markup

**Problem**: Changes not properly aligned

**Solutions**:
- Ensure similar document structure between versions
- Try different latexdiff algorithms (implemented via the merge agent)
- Break down large changes into smaller, more manageable edits

### Git Integration Issues

**Problem**: No commits shown in dropdown

**Solutions**:
- Verify the document is in a Git repository
- Refresh the commit list using the refresh icon
- Check Git installation and configuration

**Problem**: Error when comparing with commit

**Solutions**:
- Ensure the file existed in the selected commit
- Check for file path changes or renames
- Verify Git access permissions

## Best Practices

### Preparing Documents for Diff

For best results with LaTeX diff:

1. **Consistent Formatting**: Use consistent indentation and line breaks
2. **Run latexindent**: Format both documents before comparing
3. **Sensible Line Breaks**: Break lines at logical points like sentences
4. **Clean Documents**: Remove comments and unnecessary code

### Reviewing Diff Documents

When reviewing diff documents:

1. **Compile First**: Always compile the diff document to see rendered changes
2. **Systematic Review**: Go through changes methodically, section by section
3. **Check Context**: Look at the context around each change
4. **Verify Math**: Pay special attention to changes in mathematical expressions
5. **Check References**: Verify cross-references and citations remain intact

### Version Management

Maintain a clear version strategy:

1. **Regular Commits**: Commit document versions at meaningful milestones
2. **Descriptive Messages**: Use clear commit messages describing changes
3. **Pack Old Diffs**: Use the "Pack" button to archive diff files
4. **Clean Unnecessary Files**: Remove temporary diff files when no longer needed

## Next Steps

Now that you understand CoAuthor's LaTeX diff functionality, you might want to explore:

- [Intelligent Merge](/guide/intelligent-merge) - Learn how to combine changes intelligently
- [File Management](/guide/file-management) - Understand how to organize your files effectively
- [Best Practices](/reference/best-practices) - Discover recommended workflows using diff features
