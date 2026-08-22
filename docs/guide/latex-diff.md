<script setup>
import DiffMarkupHero from '../.vitepress/components/DiffMarkupHero.vue';
import DiffArtifactsHero from '../.vitepress/components/DiffArtifactsHero.vue';
</script>

# LaTeX diff

When an agent revises a derivation, a proof, or a section of your paper, you should be able to check every change it made. TeXRA shows each suggested change in the typeset document before you decide how to incorporate it.

<LatexDiffHero />

<p class="hero-caption">Pick a base and an edited file (or a git commit), press latexdiff, and TeXRA compiles and opens the marked-up PDF: additions underlined in blue, deletions struck through in red.</p>

TeXRA generates diff files after agent runs that modify `.tex` files (such as `correct` or `polish`), comparing the agent's task-storage output (for example `r0/intro.tex` or `r1/intro.tex` for an `intro.tex` input) against the original input or the previous round's output. You can see what the agent did as soon as the run finishes.

This guide explains how to use TeXRA's LaTeXdiff features to compare arbitrary file versions and how to read the results.

::: tip CLI
The LaTeXDiffs section buttons described below belong to the VS Code
extension. The automatic post-run diffs are generated on every host, including
`texra run polish` or `texra run correct` in the CLI, where the TUI lists them
as "Latexdiff results". To diff two arbitrary files from the terminal, use the
[`latexDiff` agent](./built-in-agents.md#latexdiff), which wraps `latexdiff`
to compare two LaTeX versions.
:::

### Controlling between-round diffs

TeXRA compares each round of agent output to your original input and can also create diffs between consecutive rounds (`_diffr1r0.tex` for the r0→r1 comparison). Between-round diffs are off by default. Enable them from the **Dashboard → LaTeX** tab (the `texra.latexdiff.generateBetweenRoundDiffs` setting in the VS Code extension). When off, the run command and progress notifications only account for the original-vs-round comparisons, so fewer diff files are created.

### Focusing diff PDFs on changed pages

By default, TeXRA passes `--subtype=ONLYCHANGEDPAGE` to `latexdiff` so compiled diff PDFs show only pages with edits. Disable **Show only changed pages in latexdiff PDFs** in the LaTeX tab when you need a full-document diff PDF.

## Understanding LaTeX diff

Standard text diff tools can be hard to read when comparing LaTeX source. LaTeX diff understands LaTeX syntax and produces readable, compilable LaTeX documents with changes highlighted. This approach has several advantages:

1. **Structural awareness**: Understands LaTeX environments and commands
2. **Visual clarity**: Shows changes within the typeset document
3. **Compilable output**: Produces valid LaTeX documents that can be compiled
4. **Academic focus**: Optimized for scholarly documents with equations, figures, and citations

## The LaTeXDiffs section

The LaTeX diff features live in the "LaTeXDiffs" section (<wa-icon library="texra" name="chevron-down"></wa-icon> LaTeXDiffs) of the TeXRA interface, shown in the slice above.

This section provides:

1. **Base file selection**: Choose an original/base document
2. **Edited file selection**: Select a modified version
3. **Diff button**: Run `latexdiff` on the base and edited files and open the marked-up result
4. **Compare button**: Open the base and edited files side by side in VS Code's diff editor
5. **Merge button**: Merge changes from the edited file into the base file. Read the [Intelligent Merge workflow](./intelligent-merge.md) guide for details.
6. **Accept button**: Accept the changes from the edited file and overwrite the base file with them
7. **Git integration**: Pick a commit and use its Diff, Pack, and Clean buttons to compare with previous versions using Git history

## Basic file comparison

To compare two LaTeX files:

### Step 1: select files

1. In the "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base), select the original version
2. In the "Edited File" dropdown (<wa-icon library="texra" name="edit"></wa-icon> Edited), select the modified version

::: tip
The "Current" button (<wa-icon library="texra" name="file-code"></wa-icon>) selects the currently open file for either role. The "Empty" button (<wa-icon library="texra" name="close"></wa-icon>) clears the selection for that role.
:::

### Step 2: generate the diff

Select the **Diff** button (<wa-icon library="texra" name="diff-single"></wa-icon>) beneath the Edited dropdown. TeXRA then runs the same five-stage pipeline for every diff route; only the tool and output name change:

<FlowSteps :steps="[
  { n: 1, icon: 'diff-single', title: 'Run latexdiff', desc: 'Invokes the latexdiff tool on your selected base and edited files.' },
  { n: 2, icon: 'file-code', title: 'Write diff .tex', desc: 'Produces a marked-up LaTeX document.', chips: [{ text: 'original_diff.tex', variant: 'info', icon: 'file-code' }] },
  { n: 3, icon: 'edit', title: 'Open in editor', desc: 'Automatically opens the generated diff source.' },
  { n: 4, icon: 'play', title: 'Trigger build', desc: 'Runs LaTeX Workshop\'s build command, if the extension is installed.', chips: [{ text: 'LaTeX Workshop', variant: 'neutral' }] },
  { n: 5, icon: 'file-pdf', title: 'Open PDF', desc: 'After compilation, triggers the view command to show the diff PDF.', chips: [{ text: 'auto', variant: 'success', icon: 'check' }] }
]" />

<p class="hero-caption">After you press a diff button, TeXRA runs latexdiff, writes the marked-up <code>.tex</code>, opens it, then (with LaTeX Workshop installed) builds and views the compiled diff PDF.</p>

### Step 3: review changes

The generated diff document highlights:

- **Additions**: Usually in blue or underlined
- **Deletions**: Usually in red or struck through
- **Changes**: Shown as deletions followed by additions

## Git-based version comparison

TeXRA can also compare documents with previous Git versions:

### Step 1: select base file and commit

1. Select a base file (typically your current working file) using the "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base).
2. Choose a Git commit from the "Commit" dropdown (<wa-icon library="texra" name="git-commit"></wa-icon> Commit).

::: info
The commit dropdown shows recent commits. Select the refresh icon (<wa-icon library="texra" name="refresh"></wa-icon>) next to the label to update the list.
:::

### Step 2: generate the diff

Select the **Diff** button (<wa-icon library="texra" name="diff-single"></wa-icon>) beneath the Commit dropdown to compare your file with its version at the selected commit.

TeXRA runs the same five-stage pipeline shown above. This route uses the `latexdiff-vc` tool and names its output with the commit hash (for example `original-diff<commit_hash>.tex`).

### Step 3: manage diff outputs

After generating a Git-based diff with the **Diff** button beneath the Commit dropdown, you can manage the resulting files from the Commit section's **Pack** (<wa-icon library="texra" name="archive"></wa-icon>) and **Clean** (<wa-icon library="texra" name="trash"></wa-icon>) buttons. Pack archives the diff files; Clean removes them.

Each diff route writes its own predictably named artifacts. `latexdiff` produces `_diff.tex` and `latexdiff-vc` appends the commit hash (`-diff<hash>.tex`), both alongside the base file. Agent runs write round (`_diff.tex`) and between-round (`_diffr<newer>r<older>.tex`) diffs into the run's task storage. Every `.tex` compiles to a matching `.pdf`. Pack and Clean act on the selected commit's diff files:

<DiffArtifactsHero />

<p class="hero-caption">The diff file-naming scheme as one set: the base/edited source pair, then each generated diff (<code>latexdiff</code>, <code>latexdiff-vc</code> with its commit hash, and between-round) paired with its compiled PDF. The Pack and Clean buttons archive or remove the selected commit's diff files.</p>

## Understanding diff output

The diff document uses dedicated markup to highlight changes:

### Default markup

By default, latexdiff wraps each edit in a markup command that is defined in the preamble of the generated document and typesets the change inline:

<DiffMarkupHero />

<p class="hero-caption">latexdiff's source commands and how they typeset: <code>\DIFadd{…}</code> renders as a blue underlined addition, <code>\DIFdel{…}</code> as a red struck-through deletion, and adjacent del+add forms a change.</p>

### Interpreting complex changes

For complex LaTeX structures, pay attention to:

1. **Math environments**: How changes inside equations are marked is configurable. The **latexdiff math markup** setting in the Dashboard's LaTeX tab (`texra.latexdiff.mathMarkup`) offers suppress markup, equation-level, within equations, or small changes inside equations, and applies to every diff route
2. **Nested environments**: Changes within nested environments can be hard to read
3. **Command arguments**: Changes to command arguments are marked specially
4. **Whitespace changes**: May or may not be highlighted depending on settings

## Advanced diff usage

### Comparing multiple files

For documents split across multiple files:

1. Use the `merge` agent instead of the basic diff
2. Select the multiple input files and their edited counterparts; the agent takes one or more original/edited file pairs, not a directory
3. Review each merged output, then diff it against its original

## Integration with workflow

LaTeX diff fits into several TeXRA workflows:

### Document review workflow

1. Generate the initial document with a suitable agent
2. Make manual edits or use another agent for revision
3. Use latexdiff to compare original and revised versions
4. Review and accept or reject changes
5. Use merge to create the final version

### Collaborative editing workflow

1. Share the base document with collaborators
2. Receive edited versions back
3. Use latexdiff to visualize each contributor's changes
4. Use merge to incorporate changes selectively
5. Generate diffs of the merged document to confirm the result

### Version control workflow

1. Commit document versions regularly to Git
2. Use latexdiff-vc to compare with previous versions
3. Track how the document evolves over time
4. Identify when specific changes were made
5. Recover and merge content from previous versions as needed

## Under the hood

TeXRA's LaTeX diff builds on several tools:

### latexdiff tool

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

### Merge process

The intelligent merge process:

1. Analyzes both documents semantically
2. Identifies substantive changes
3. Creates a new document combining the best elements
4. Optionally generates a diff showing applied changes

## Troubleshooting

### Common diff issues

**Problem**: Missing or incomplete highlights

**Solutions**:

- Make sure both documents are valid LaTeX
- Check for complex structures that might confuse latexdiff
- Compare smaller sections of the document

**Problem**: Diff document doesn't compile

**Solutions**:

- Look for conflicting markup in the preamble
- Check for unclosed environments or commands
- Remove complex custom commands that might interfere with diff markup

**Problem**: Changes not aligned

**Solutions**:

- Keep the document structure similar between versions
- Adjust the latexdiff settings in the Dashboard's LaTeX tab: **latexdiff math markup**, **latexdiff timeout (ms)**, **Generate diffs between consecutive rounds**, and **Show only changed pages in latexdiff PDFs**
- Break large changes into smaller edits

### Git integration issues

**Problem**: No commits shown in dropdown

**Solutions**:

- Verify the document is in a Git repository
- Refresh the commit list using the refresh icon (<wa-icon library="texra" name="refresh"></wa-icon>)
- Check Git installation and configuration

**Problem**: Error when comparing with commit

**Solutions**:

- Make sure the file existed in the selected commit
- Check for file path changes or renames
- Verify Git access permissions

## Best practices

**Before comparing**, run a formatter (`latexindent` or `tex-fmt`) on both documents. Consistent indentation and line breaks keep `latexdiff` from flagging pure-whitespace changes.

**When reviewing**:

1.  **Compile first**: Compile the generated `_diff.tex` document to see the rendered changes (as shown in the slice at the top of this page). TeXRA does this automatically using LaTeX Workshop if it is installed. Live examples are embedded below.

2.  **VS Code diff view**: For a quick source-level comparison, pick the original (`draft.tex`) as the base file and the generated diff source (`draft_diff.tex` for a workspace diff, `draft-diff<hash>.tex` for a commit diff, or `draft_diffr1r0.tex` between rounds) as the edited file, then press **Compare** in the LaTeXDiffs section. This opens both files side by side in VS Code's diff editor, as shown below.

3.  **Verify the fragile parts**: mathematical expressions, cross-references, and citations are where AI edits most often go wrong.

<CompareHero />

<p class="hero-caption">VS Code's side-by-side comparison of the original <code>draft.tex</code> against the generated diff source: additions and deletions highlighted line by line.</p>

#### Embedded PDF examples

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

::: details Individual PDF examples

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

### Version management

Keep a clear version strategy:

1. **Regular commits**: Commit document versions at meaningful milestones
2. **Descriptive messages**: Write commit messages that describe the changes
3. **Pack old diffs**: Use the "Pack" button to archive diff files
4. **Clean unnecessary files**: Remove temporary diff files when no longer needed

## Next steps

- [Intelligent Merge](/guide/intelligent-merge): combine changes from two versions
- [File management](/guide/file-management): organize your files
- [Best practices](/guide/best-practices): recommended workflows using diff features
