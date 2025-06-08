# LaTeX Diff

A core design philosophy of TeXRA is to provide transparency and control over the AI's modifications. The integrated LaTeX diff functionality is central to this, allowing you to precisely see and evaluate the changes suggested by AI agents before deciding how to incorporate them.

TeXRA automatically generates diff files after agent runs that modify `.tex` files (like `correct` or `polish`), comparing the agent's output (`*_r0_*.tex` or `*_r1_*.tex`) against the original input or the previous round's output. This provides immediate observability into the agent's actions.

This guide explains how to use TeXRA's dedicated LaTeXdiff features for comparing arbitrary file versions and understanding the results.

## Understanding LaTeX Diff

Unlike standard text diff tools (which can look like hieroglyphics when comparing LaTeX source), LaTeX diff understands LaTeX syntax and produces readable, compilable LaTeX documents with changes highlighted. This approach offers several advantages:

1. **Structural Awareness**: Understands LaTeX environments and commands
2. **Visual Clarity**: Shows changes within the typeset document
3. **Compilable Output**: Produces valid LaTeX documents that can be compiled
4. **Academic Focus**: Optimized for scholarly documents with equations, figures, and citations

## The LaTeXdiffs Section

The LaTeX diff functionality is accessible through the "LaTeXdiffs" section (<i class="codicon codicon-chevron-down"></i> LaTeXDiffs) in the TeXRA interface:

<!-- ![LaTeXdiffs Section](/images/latexdiffs-section.png) -->

This section provides several key features:

1. **Base File Selection**: Choose an original/base document
2. **Edited File Selection**: Select a modified version
3. **latexdiff Button**: Generate a diff between two files
4. **Git Integration**: Compare with previous versions using Git history
5. **Merge Button**: Intelligently merge changes from edited file to base file. See the [Intelligent Merge Workflow](./intelligent-merge.md) guide for details.

## Basic File Comparison

To compare two LaTeX files:

### Step 1: Select Files

1. In the "Base File" dropdown (<i class="codicon codicon-file"></i> Base), select the original version
2. In the "Edited File" dropdown (<i class="codicon codicon-edit"></i> Edited), select the modified version

::: tip
The "Current" button (<i class="codicon codicon-file-code"></i>) allows you to quickly select the currently open file for either role. The "Empty" button (<i class="codicon codicon-close"></i>) clears the selection for that role.
:::

### Step 2: Generate the Diff

Click the "latexdiff" button with the <i class="codicon codicon-diff-single"></i> icon.

TeXRA will:

1. Run the `latexdiff` tool on your selected files.
2. Generate a new LaTeX document (e.g., `original_diff.tex`) with highlighted changes.
3. **Automatically open** this generated `.tex` diff file in your editor.
4. If the [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) extension is installed, TeXRA will then automatically trigger its **build** command for the diff file.
5. After a short delay (to allow compilation), it will trigger LaTeX Workshop's **view** command to show the compiled PDF diff.

### Step 3: Review Changes

The generated diff document will highlight:

- **Additions**: Usually in blue or underlined
- **Deletions**: Usually in red or struck through
- **Changes**: Shown as deletions followed by additions

<!-- ![LaTeX Diff Example](/images/latex-diff-example.png) -->

## Git-Based Version Comparison

TeXRA also allows you to compare documents with previous Git versions:

### Step 1: Select Base File and Commit

1. Select a base file (typically your current working file) using the "Base File" dropdown (<i class="codicon codicon-file"></i> Base).
2. Choose a Git commit from the "Commit" dropdown (<i class="codicon codicon-git-commit"></i> Commit).

::: info
The commit dropdown shows recent commits. Click the refresh icon (<i class="codicon codicon-refresh"></i>) next to the label to update the list.
:::

### Step 2: Generate the Diff

Click the "latexdiff-vc" button (<i class="codicon codicon-diff-single"></i> icon) to compare your file with its version at the selected commit.

TeXRA will:

1. Run the `latexdiff-vc` tool using the selected file and commit.
2. Generate a new LaTeX document (e.g., `original_diff_rev[commit_hash].tex`) with highlighted changes.
3. **Automatically open** this generated `.tex` diff file in your editor.
4. If the [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) extension is installed, TeXRA will then automatically trigger its **build** command for the diff file.
5. After a short delay (to allow compilation), it will trigger LaTeX Workshop's **view** command to show the compiled PDF diff.

### Step 3: Manage Diff Outputs

After generating a Git-based diff using the "latexdiff-vc" button, you can:

- **Pack** (<i class="codicon codicon-archive"></i>): Archive the diff files using the "Pack" button in the Commit section.
- **Clean** (<i class="codicon codicon-trash"></i>): Remove the diff files using the "Clean" button in the Commit section.

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

## Integration with Workflow

LaTeX diff integrates with several TeXRA workflows:

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

TeXRA's LaTeX diff functionality builds on several key technologies:

### latexdiff Tool

[latexdiff](https://ctan.org/pkg/latexdiff) is a Perl script that compares LaTeX files and generates a marked-up LaTeX document highlighting differences.

TeXRA:

1. Calls latexdiff with appropriate options
2. Processes the output for consistency
3. Applies additional formatting as needed

### latexdiff-vc

[latexdiff-vc](https://ctan.org/pkg/latexdiff) (version control) extends latexdiff to work with version control systems like Git.

TeXRA:

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
- Refresh the commit list using the refresh icon (<i class="codicon codicon-refresh"></i>)
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
2. **Run a formatter**: Use `latexindent` or `tex-fmt` on both documents before comparing
3. **Sensible Line Breaks**: Break lines at logical points like sentences
4. **Clean Documents**: Remove comments and unnecessary code

### Reviewing Diff Documents

When reviewing diff documents generated by TeXRA (e.g., from the example file `/examples/draft.tex`):

1.  **Compile First**: Always compile the generated `_diff.tex` document to see the rendered changes visually. TeXRA attempts to do this automatically using LaTeX Workshop if installed.

    _Example Rendered Diff (Original vs. Round 1):_
    ![Visual Diff Output](/images/latexdff-v1.png)

2.  **VS Code Diff View**: For a quick source-level comparison, open both the original (`draft.tex`) and the generated diff source (`draft_polish_r1_gemini25p_diff.tex` or similar) in VS Code. Select both files in the Explorer, right-click, and choose "Compare Selected". This highlights source code changes side-by-side.

    _Example VS Code Side-by-Side Diff:_
    ![VS Code Side-by-Side Diff](/images/vscode-compare.png)

3.  **Systematic Review**: Go through changes methodically, section by section, in either the compiled PDF or the source diff.
4.  **Check Context**: Look at the context around each change.
5.  **Verify Math**: Pay special attention to changes in mathematical expressions.
6.  **Check References**: Verify cross-references and citations remain intact.

#### Embedded PDF Examples

<div class="pdf-examples">
  <div class="pdf-tabs">
    <button type="button" class="pdf-tab active" data-pdf="/examples/draft_polish_r0_gemini25p_diff.pdf">Round 0: Initial AI Edit</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diff.pdf">Round 1: After Reflection</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf">Reflection Changes</button>
  </div>
  <div class="pdf-viewer">
    <iframe src="/examples/draft_polish_r0_gemini25p_diff.pdf" id="pdf-frame" class="pdf-frame"></iframe>
    <a href="/examples/draft_polish_r0_gemini25p_diff.pdf" target="_blank" id="pdf-link" class="pdf-link">Open in new tab</a>
  </div>
</div>

::: details Individual PDF Examples

- [Original vs. Round 0 (Initial AI Output)](/examples/draft_polish_r0_gemini25p_diff.pdf)
- [Original vs. Round 1 (After Reflection)](/examples/draft_polish_r1_gemini25p_diff.pdf)
- [Round 0 vs. Round 1 (Reflection Changes)](/examples/draft_polish_r1_gemini25p_diffr1r0.pdf)
- [Original Document](/examples/draft.pdf)
  :::

<style>
.pdf-examples {
  margin: 1rem 0;
}
.pdf-tabs {
  display: flex;
  border-bottom: 1px solid var(--vp-c-divider);
  margin-bottom: 0.5rem;
}
.pdf-tab {
  padding: 0.5rem 1rem;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  font-size: 0.9rem;
  text-decoration: none;
  color: inherit;
  background: none;
  font-family: inherit;
  text-align: center;
}
.pdf-tab:hover {
  background-color: var(--vp-c-bg-soft);
}
.pdf-tab.active {
  background-color: var(--vp-c-bg-soft);
  border-color: var(--vp-c-divider);
  border-bottom-color: var(--vp-c-bg-soft);
  color: var(--vp-c-brand);
  font-weight: 500;
  margin-bottom: -1px;
}
.pdf-viewer {
  position: relative;
  width: 100%;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
.pdf-frame {
  width: 100%;
  height: 500px;
  border: none;
}
.pdf-link {
  position: absolute;
  top: 10px;
  right: 10px;
  color: white;
  padding: 5px 10px;
  border-radius: 4px;
  text-decoration: none;
  font-size: 0.85rem;
  z-index: 10;
}
.pdf-link:hover {
  background: var(--vp-c-brand);
}
@media (max-width: 768px) {
  .pdf-tabs {
    flex-wrap: wrap;
  }
  .pdf-tab {
    font-size: 0.8rem;
    padding: 0.4rem 0.6rem;
  }
  .pdf-frame {
    height: 400px;
  }
}
</style>

### Version Management

Maintain a clear version strategy:

1. **Regular Commits**: Commit document versions at meaningful milestones
2. **Descriptive Messages**: Use clear commit messages describing changes
3. **Pack Old Diffs**: Use the "Pack" button to archive diff files
4. **Clean Unnecessary Files**: Remove temporary diff files when no longer needed

## Next Steps

Now that you understand TeXRA's LaTeX diff functionality, you may be interested in:

- [Intelligent Merge](/guide/intelligent-merge) - Learn how to combine changes intelligently
- [File Management](/guide/file-management) - Understand how to organize your files effectively
- [Best Practices](/reference/best-practices) - Discover recommended workflows using diff features
