<script setup>
import DiffMarkupHero from '../.vitepress/components/DiffMarkupHero.vue';
import DiffArtifactsHero from '../.vitepress/components/DiffArtifactsHero.vue';
</script>

# LaTeX Diff

A core design philosophy of TeXRA is transparency and control over the AI's modifications. You see and evaluate every change an agent suggests, in the typeset document, before deciding how to incorporate it.

<LatexDiffHero />

<p class="hero-caption">Pick a base and an edited file (or a git commit), press latexdiff, and TeXRA compiles and opens the marked-up PDF — additions underlined in blue, deletions struck through in red.</p>

TeXRA automatically generates diff files after agent runs that modify `.tex` files (like `correct` or `polish`), comparing the agent's task-storage output (e.g. `r0/intro.tex` or `r1/intro.tex` for an `intro.tex` input) against the original input or the previous round's output. This provides immediate observability into the agent's actions.

This guide explains how to use TeXRA's dedicated LaTeXdiff features for comparing arbitrary file versions and understanding the results.

::: tip CLI
The automatic post-run diffs and the buttons described below belong to the VS Code
extension. To produce a diff PDF from the terminal, use the [`latexDiff`
agent](./built-in-agents.md#latexdiff), which wraps `latexdiff` to compare two
LaTeX versions.
:::

### Controlling Between-Round Diffs

TeXRA compares each round of agent output to your original input and can also create diffs between consecutive rounds (`_diffr1r0.tex` for the r0→r1 comparison). Between-round diffs are disabled by default—enable them from the **Dashboard → LaTeX** tab (the `texra.latexdiff.generateBetweenRoundDiffs` setting in the VS Code extension). When left off, the run command and progress notifications only account for the original-vs-round comparisons, reducing the number of diff files created.

### Focusing Diff PDFs on Changed Pages

By default, TeXRA passes `--subtype=ONLYCHANGEDPAGE` to `latexdiff` so compiled diff PDFs focus on pages with edits. Disable **Show only changed pages in latexdiff PDFs** in the LaTeX tab when you need a full-document diff PDF.

## Understanding LaTeX Diff

Unlike standard text diff tools (which can look like hieroglyphics when comparing LaTeX source), LaTeX diff understands LaTeX syntax and produces readable, compilable LaTeX documents with changes highlighted. This approach offers several advantages:

1. **Structural Awareness**: Understands LaTeX environments and commands
2. **Visual Clarity**: Shows changes within the typeset document
3. **Compilable Output**: Produces valid LaTeX documents that can be compiled
4. **Academic Focus**: Optimized for scholarly documents with equations, figures, and citations

## The LaTeXdiffs Section

The LaTeX diff functionality is accessible through the "LaTeXdiffs" section (<wa-icon library="texra" name="chevron-down"></wa-icon> LaTeXDiffs) in the TeXRA interface, shown in the slice above.

This section provides several key features:

1. **Base File Selection**: Choose an original/base document
2. **Edited File Selection**: Select a modified version
3. **latexdiff Button**: Generate a diff between two files
4. **Git Integration**: Compare with previous versions using Git history
5. **Merge Button**: Intelligently merge changes from edited file to base file. See the [Intelligent Merge Workflow](./intelligent-merge.md) guide for details.

## Basic File Comparison

To compare two LaTeX files:

### Step 1: Select Files

1. In the "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base), select the original version
2. In the "Edited File" dropdown (<wa-icon library="texra" name="edit"></wa-icon> Edited), select the modified version

::: tip
The "Current" button (<wa-icon library="texra" name="file-code"></wa-icon>) allows you to quickly select the currently open file for either role. The "Empty" button (<wa-icon library="texra" name="close"></wa-icon>) clears the selection for that role.
:::

### Step 2: Generate the Diff

Click the **Diff** button (<wa-icon library="texra" name="diff-single"></wa-icon>) beneath the Edited dropdown. TeXRA then runs the same five-stage pipeline for every diff route — only the tool and output name change:

<FlowSteps :steps="[
  { n: 1, icon: 'diff-single', title: 'Run latexdiff', desc: 'Invokes the latexdiff tool on your selected base and edited files.' },
  { n: 2, icon: 'file-code', title: 'Write diff .tex', desc: 'Produces a marked-up LaTeX document.', chips: [{ text: 'original_diff.tex', variant: 'info', icon: 'file-code' }] },
  { n: 3, icon: 'edit', title: 'Open in editor', desc: 'Automatically opens the generated diff source.' },
  { n: 4, icon: 'play', title: 'Trigger build', desc: 'Runs LaTeX Workshop\'s build command, if the extension is installed.', chips: [{ text: 'LaTeX Workshop', variant: 'neutral' }] },
  { n: 5, icon: 'file-pdf', title: 'Open PDF', desc: 'After compilation, triggers the view command to show the diff PDF.', chips: [{ text: 'auto', variant: 'success', icon: 'check' }] }
]" />

<p class="hero-caption">After you press a diff button, TeXRA runs latexdiff, writes the marked-up <code>.tex</code>, opens it, then (with LaTeX Workshop installed) builds and views the compiled diff PDF.</p>

### Step 3: Review Changes

The generated diff document will highlight:

- **Additions**: Usually in blue or underlined
- **Deletions**: Usually in red or struck through
- **Changes**: Shown as deletions followed by additions

## Git-Based Version Comparison

TeXRA also allows you to compare documents with previous Git versions:

### Step 1: Select Base File and Commit

1. Select a base file (typically your current working file) using the "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base).
2. Choose a Git commit from the "Commit" dropdown (<wa-icon library="texra" name="git-commit"></wa-icon> Commit).

::: info
The commit dropdown shows recent commits. Click the refresh icon (<wa-icon library="texra" name="refresh"></wa-icon>) next to the label to update the list.
:::

### Step 2: Generate the Diff

Click the **Diff** button (<wa-icon library="texra" name="diff-single"></wa-icon>) beneath the Commit dropdown to compare your file with its version at the selected commit.

TeXRA runs the same five-stage pipeline shown above — only this route uses the `latexdiff-vc` tool and names its output with the commit hash (e.g., `original-diff<commit_hash>.tex`).

### Step 3: Manage Diff Outputs

After generating a Git-based diff using the **Diff** button beneath the Commit dropdown, you can manage the resulting files from the Commit section's **Pack** (<wa-icon library="texra" name="archive"></wa-icon>) and **Clean** (<wa-icon library="texra" name="trash"></wa-icon>) buttons. Pack archives the diff files; Clean removes them.

Each diff route writes its own predictably-named artifacts — `latexdiff` produces `_diff.tex` and `latexdiff-vc` appends the commit hash (`-diff<hash>.tex`), both alongside the base file, while agent runs write round (`_diff.tex`) and between-round (`_diffr<newer>r<older>.tex`) diffs into the run's task storage — and every `.tex` compiles to a matching `.pdf`. Pack and Clean act on the selected commit's diff files:

<DiffArtifactsHero />

<p class="hero-caption">The diff file-naming scheme grounded as one set — the base/edited source pair, then each generated diff (<code>latexdiff</code>, <code>latexdiff-vc</code> with its commit hash, and between-round) paired with its compiled PDF. The Pack and Clean buttons archive or remove the selected commit's diff files.</p>

## Understanding Diff Output

The diff document uses a specialized markup to highlight changes:

### Default Markup

By default, latexdiff wraps each edit in a markup command that is defined in the preamble of the generated document and typesets the change inline:

<DiffMarkupHero />

<p class="hero-caption">latexdiff's source commands and how they typeset — <code>\DIFadd{…}</code> renders as a blue underlined addition, <code>\DIFdel{…}</code> as a red struck-through deletion, and adjacent del+add forms a change.</p>

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
- Refresh the commit list using the refresh icon (<wa-icon library="texra" name="refresh"></wa-icon>)
- Check Git installation and configuration

**Problem**: Error when comparing with commit

**Solutions**:

- Ensure the file existed in the selected commit
- Check for file path changes or renames
- Verify Git access permissions

## Best Practices

**Before comparing**, run a formatter (`latexindent` or `tex-fmt`) on both documents — consistent indentation and line breaks keep `latexdiff` from flagging pure-whitespace changes.

**When reviewing**:

1.  **Compile First**: Always compile the generated `_diff.tex` document to see the rendered changes visually (as shown in the slice at the top of this page). TeXRA attempts to do this automatically using LaTeX Workshop if installed. Live examples are embedded below.

2.  **VS Code Diff View**: For a quick source-level comparison, open both the original (`draft.tex`) and the generated diff source (`draft_polish_r1_gemini25p_diff.tex` or similar) in VS Code. Select both files in the Explorer, right-click, and choose "Compare Selected". This highlights source code changes side-by-side, as shown below.

3.  **Verify the fragile parts**: mathematical expressions, cross-references, and citations are where AI edits most often go wrong.

<CompareHero />

<p class="hero-caption">VS Code's side-by-side comparison of the original <code>draft.tex</code> against the generated diff source — additions and deletions highlighted line by line.</p>

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
- [Best Practices](/guide/best-practices) - Discover recommended workflows using diff features
