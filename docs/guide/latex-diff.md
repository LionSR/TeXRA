<script setup>
import DiffMarkupHero from '../.vitepress/components/DiffMarkupHero.vue';
import DiffArtifactsHero from '../.vitepress/components/DiffArtifactsHero.vue';
</script>

# LaTeX diff

When an agent revises a derivation, proof, or section of your manuscript, you need to verify every modification. TeXRA renders each proposed change directly in the typeset document so you can evaluate edits in their full visual and mathematical context.

<LatexDiffHero />

<p class="hero-caption">Pick a base and an edited file (or a git commit), press latexdiff, and TeXRA compiles and opens the marked-up PDF: additions underlined in blue, deletions struck through in red.</p>

TeXRA generates diff files after agent runs that modify `.tex` files (such as `correct` or `polish`), comparing the agent's run-storage output (for example `r0/intro.tex` or `r1/intro.tex` for an `intro.tex` input) against the original input or the previous revision's output. You can see what the agent did as soon as the run finishes.

This guide explains how to use TeXRA's LaTeXdiff features to compare arbitrary file versions and how to read the results.

::: tip CLI
The LaTeXDiffs section buttons described below belong to the VS Code
extension. The automatic post-run diffs are generated on every host, including
`texra run polish` or `texra run correct` in the CLI, where the TUI lists them
as "Latexdiff results". To diff two arbitrary files from the terminal, use the
[`latexDiff` agent](./built-in-agents.md#latexdiff), which wraps `latexdiff`
to compare two LaTeX versions.
:::

### Controlling between-revision diffs

TeXRA compares each revision of agent output to your original input and can also create diffs between consecutive revisions (`_diffr1r0.tex` for the r0→r1 comparison). Between-revision diffs are off by default. Enable **Diff consecutive rounds** on **Settings → LaTeX → Compile & diff** (the `texra.latexdiff.generateBetweenRoundDiffs` setting). When off, the run command and progress notifications only account for the original-vs-revision comparisons, so fewer diff files are created.

### Focusing diff PDFs on changed pages

By default, TeXRA passes `--subtype=ONLYCHANGEDPAGE` to `latexdiff` so compiled diff PDFs show only pages with edits. Disable **Only changed pages in diff PDFs** in the LaTeX tab when you need a full-document diff PDF.

## The LaTeXDiffs section

The LaTeX diff features live in the "LaTeXDiffs" section (<wa-icon library="texra" name="chevron-down"></wa-icon> LaTeXDiffs) of the TeXRA interface, shown in the slice above.

This section provides:

1. **Base file selection**: Choose an original/base document
2. **Edited file selection**: Select a modified version
3. **Diff vs. edited button**: Run `latexdiff` on the base and edited files and open the marked-up result
4. **Compare button**: Open the base and edited files side by side in VS Code's diff editor
5. **Merge button**: Merge changes from the edited file into the base file. Read the [Intelligent Merge workflow](./intelligent-merge.md) guide for details.
6. **Accept button**: Accept the changes from the edited file and overwrite the base file with them
7. **Git integration**: Pick a commit and use its Diff vs. commit, Move to Diffs folder, and Delete diff files buttons to compare with previous versions using Git history

## Basic file comparison

To compare two LaTeX files:

### Step 1: select files

1. In the "Base File" dropdown (<wa-icon library="texra" name="file"></wa-icon> Base), select the original version
2. In the "Edited File" dropdown (<wa-icon library="texra" name="edit"></wa-icon> Edited), select the modified version

::: tip
The "Current" button (<wa-icon library="texra" name="file-code"></wa-icon>) selects the currently open file for either role. The "Empty" button (<wa-icon library="texra" name="close"></wa-icon>) clears the selection for that role.
:::

### Step 2: generate the diff

Select the **Diff vs. edited** button (<wa-icon library="texra" name="diff-single"></wa-icon>) beneath the Edited dropdown. TeXRA then runs the same five-stage pipeline for every diff route; only the tool and output name change:

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

Select the **Diff vs. commit** button (<wa-icon library="texra" name="diff-single"></wa-icon>) beneath the Commit dropdown to compare your file with its version at the selected commit.

TeXRA runs the same five-stage pipeline shown above. This route uses the `latexdiff-vc` tool and names its output with the commit hash (for example `original-diff<commit_hash>.tex`).

### Step 3: manage diff outputs

After generating a Git-based diff with **Diff vs. commit**, you can manage the resulting files from the Commit section's **Move to Diffs folder** (<wa-icon library="texra" name="archive"></wa-icon>) and **Delete diff files** (<wa-icon library="texra" name="trash"></wa-icon>) buttons. Move to Diffs folder moves the diff `.tex` and `.pdf` into a dated folder under `Diffs/` and deletes their build files; Delete diff files removes them all.

Each diff route writes its own predictably named artifacts. `latexdiff` produces `_diff.tex` and `latexdiff-vc` appends the commit hash (`-diff<hash>.tex`), both alongside the base file. Document tasks write per-revision (`_diff.tex`) and between-revision (`_diffr<newer>r<older>.tex`) diffs into the run folder. Every `.tex` compiles to a matching `.pdf`. Both buttons act on the selected commit's diff files:

<DiffArtifactsHero />

<p class="hero-caption">The diff file-naming scheme as one set: the base/edited source pair, then each generated diff (<code>latexdiff</code>, <code>latexdiff-vc</code> with its commit hash, and between-revision) paired with its compiled PDF. Move to Diffs folder and Delete diff files file away or remove the selected commit's diff files.</p>

## Understanding diff output

The diff document uses dedicated markup to highlight changes:

### Default markup

By default, latexdiff wraps each edit in a markup command that is defined in the preamble of the generated document and typesets the change inline:

<DiffMarkupHero />

<p class="hero-caption">latexdiff's source commands and how they typeset: <code>\DIFadd{…}</code> renders as a blue underlined addition, <code>\DIFdel{…}</code> as a red struck-through deletion, and adjacent del+add forms a change.</p>

### Math markup and multi-file projects

- **Math environments**: The **Math markup in diffs** setting on **Settings → LaTeX** (`texra.latexdiff.mathMarkup`) controls how changes inside equations are marked (suppress markup, equation-level, within equations, or small changes inside equations) across every diff route.
- **Comparing multiple files**: For documents split across several files, use the [`merge`](./intelligent-merge.md) agent on each original/edited file pair, then diff the merged output against its original.

## Troubleshooting

- **Missing or misaligned highlights**: Run a formatter (`latexindent` or `tex-fmt`) on both files first so line breaks match, or adjust **Math markup in diffs**, **Diff consecutive rounds**, and **Only changed pages in diff PDFs** on **Settings → LaTeX** (the `latexdiff` timeout is in the CLI's `/config`).
- **Diff document fails to compile**: Complex custom macros or unclosed environments can conflict with `\DIFadd` / `\DIFdel` markup. Check that both input files compile cleanly on their own, or lower **Math markup in diffs** to equation-level or suppress markup.
- **Git commit diff fails or shows no commits**: Confirm the workspace is a Git repository, click the refresh icon (<wa-icon library="texra" name="refresh"></wa-icon>) next to **Commit**, and verify the file existed at the selected commit under the same relative path.

## Best practices

**Before comparing**, run a formatter (`latexindent` or `tex-fmt`) on both documents. Consistent indentation and line breaks keep `latexdiff` from flagging pure-whitespace changes.

**When reviewing**:

1.  **Compile first**: Compile the generated `_diff.tex` document to see the rendered changes (as shown in the slice at the top of this page). TeXRA does this automatically using LaTeX Workshop if it is installed. Live examples are embedded below.

2.  **VS Code diff view**: For a quick source-level comparison, pick the original (`draft.tex`) as the base file and the generated diff source (`draft_diff.tex` for a workspace diff, `draft-diff<hash>.tex` for a commit diff, or `draft_diffr1r0.tex` between revisions) as the edited file, then press **Compare** in the LaTeXDiffs section. This opens both files side by side in VS Code's diff editor, as shown below.

3.  **Verify the fragile parts**: mathematical expressions, cross-references, and citations are where AI edits most often go wrong.

<CompareHero />

<p class="hero-caption">VS Code's side-by-side comparison of the original <code>draft.tex</code> against the generated diff source: additions and deletions highlighted line by line.</p>

#### Embedded PDF examples

<div class="pdf-examples">
  <div class="pdf-tabs">
    <button type="button" class="pdf-tab active" data-pdf="/examples/draft_polish_r0_gemini25p_diff.pdf">Revision 1: Initial AI Edit</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diff.pdf">Revision 2: After Reflection</button>
    <button type="button" class="pdf-tab" data-pdf="/examples/draft_polish_r1_gemini25p_diffr1r0.pdf">Reflection Changes</button>
  </div>
  <div class="pdf-viewer">
    <iframe src="/examples/draft_polish_r0_gemini25p_diff.pdf" id="pdf-frame" class="pdf-frame"></iframe>
    <a href="/examples/draft_polish_r0_gemini25p_diff.pdf" target="_blank" id="pdf-link" class="pdf-link">Open in new tab</a>
  </div>
</div>

::: details Individual PDF examples

- [Original vs. Revision 1 (Initial AI Output)](/examples/draft_polish_r0_gemini25p_diff.pdf)
- [Original vs. Revision 2 (After Reflection)](/examples/draft_polish_r1_gemini25p_diff.pdf)
- [Revision 1 vs. Revision 2 (Reflection Changes)](/examples/draft_polish_r1_gemini25p_diffr1r0.pdf)
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

## Next steps

- [Intelligent Merge](/guide/intelligent-merge): combine changes from two versions
- [File management](/guide/file-management): organize your files
- [Best practices](/guide/best-practices): recommended workflows using diff features
