<script setup>
import DiffMarkupHero from '../.vitepress/components/DiffMarkupHero.vue';
import DiffArtifactsHero from '../.vitepress/components/DiffArtifactsHero.vue';
</script>

# LaTeX diff

When an agent revises a derivation, proof, or section of your manuscript, you need to verify every modification. TeXRA renders each proposed change directly in the typeset document so you can evaluate edits in their full visual and mathematical context.

<LatexDiffHero />

<p class="hero-caption">Pick a base and an edited file (or a git commit), press <strong>Diff vs. edited</strong> (or <strong>Diff vs. commit</strong>), and TeXRA compiles and opens the marked-up PDF: additions underlined in blue, deletions struck through in red.</p>

TeXRA generates diff files after program runs that modify `.tex` files (such as `edit` or `apply`), comparing the run-storage output (for example `r0/intro.tex` or `r1/intro.tex` for an `intro.tex` input) against the original input or the previous revision's output. You can see what the program did as soon as the run finishes.

This guide explains how to use TeXRA's `latexdiff` tools to compare file versions and read the results.

::: tip CLI
The **latexdiff** sheet buttons below belong to the VS Code
extension. Automatic post-run diffs are generated in every TeXRA app, including
`texra run edit` in the CLI, where the TUI lists each one
as a `"latexdiff:"` line under its revision. To diff two arbitrary files from the terminal, run the
[`latexdiff` program](./programs.md#task-programs):
`texra run latexdiff --input old.tex --input new.tex`.
:::

### Controlling between-revision diffs

TeXRA compares each revision of a program's output to your original input and can also create diffs between consecutive revisions (`_diffr1r0.tex` for the r0→r1 comparison). Between-revision diffs are off by default. Enable **Diff consecutive revisions** on **Settings → LaTeX → Compile & diff** (the `texra.latexdiff.generateBetweenRoundDiffs` setting). When off, the run command and progress notifications only account for the original-vs-revision comparisons, so fewer diff files are created.

### Focusing diff PDFs on changed pages

By default, TeXRA passes `--subtype=ONLYCHANGEDPAGE` to `latexdiff` so compiled diff PDFs show only pages with edits. Disable **Only changed pages in diff PDFs** in the LaTeX tab when you need a full-document diff PDF.

## The latexdiff sheet

The `latexdiff` tools live in the **latexdiff** sheet, opened from the header menu of the TeXRA view via **latexdiff…**.

This section provides:

1. **Base file selection**: Choose an original/base document
2. **Edited file selection**: Select a modified version
3. **Diff vs. edited button**: Run `latexdiff` on the base and edited files and open the marked-up result
4. **Compare button**: Open the base and edited files side by side in VS Code's diff editor
5. **Accept button**: Accept the changes from the edited file and overwrite the base file with them
6. **Git integration**: Pick a commit and use its Diff vs. commit, Move to Diffs folder, and Delete diff files buttons to compare with previous versions using Git history

## Basic file comparison

To compare two LaTeX files:

### Step 1: select files

1. In the **Base** dropdown, select the original version
2. In the **Edited** dropdown, select the modified version

::: tip
The current-file button (<wa-icon library="texra" name="file-code"></wa-icon>, "Set current file as base" / "Set current file as edited") selects the currently open file for that role. The clear button (<wa-icon library="texra" name="close"></wa-icon>, "Clear base file" / "Clear edited file") clears the selection for that role. The refresh button above **Edited** (<wa-icon library="texra" name="refresh"></wa-icon>, "Refresh edited files") reloads its list.
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

## Git-based version comparison

TeXRA can also compare documents with previous Git versions:

### Step 1: select base file and commit

1. Select a base file (typically your current working file) in the **Base** dropdown.
2. Choose a Git commit from the **Commit** dropdown.

::: info
The commit dropdown shows recent commits. Select the refresh icon (<wa-icon library="texra" name="refresh"></wa-icon>, "Refresh commit list") above it to update the list.
:::

### Step 2: generate the diff

Select the **Diff vs. commit** button (<wa-icon library="texra" name="diff-single"></wa-icon>) beneath the Commit dropdown to compare your file with its version at the selected commit.

TeXRA runs the same five-stage pipeline shown above. This route uses the `latexdiff-vc` tool and names its output with the commit hash (for example `original-diff<commit_hash>.tex`).

### Step 3: manage diff outputs

After generating a Git-based diff with **Diff vs. commit**, you can manage the resulting files from the Commit section's **Move to Diffs folder** (<wa-icon library="texra" name="archive"></wa-icon>) and **Delete diff files** (<wa-icon library="texra" name="trash"></wa-icon>) buttons. Move to Diffs folder moves the diff `.tex` and `.pdf` into a dated folder under `Diffs/` and deletes their build files; Delete diff files removes them all.

Each diff route writes its own predictably named artifacts. `latexdiff` names its output after the edited file (`<edited>_diff.tex`) and `latexdiff-vc` appends the commit hash to the base file's name (`-diff<hash>.tex`), both alongside the base file. Programs write per-revision (`_diff.tex`) and between-revision (`_diffr<newer>r<older>.tex`) diffs into the run folder. Every `.tex` compiles to a matching `.pdf`. Both buttons act on the selected commit's diff files:

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
- **Comparing multiple files**: For documents split across several files, pass all relevant files to a program so TeXRA generates per-file diffs, or pick each base/edited pair in the **latexdiff** sheet.

## Troubleshooting

- **Missing or misaligned highlights**: Run a formatter (`latexindent` or `tex-fmt`) on both files first so line breaks match, or adjust **Math markup in diffs**, **Diff consecutive revisions**, and **Only changed pages in diff PDFs** on **Settings → LaTeX** (the `latexdiff` timeout is in the CLI's `/config`).
- **Diff document fails to compile**: Complex custom macros or unclosed environments can conflict with `\DIFadd` / `\DIFdel` markup. Check that both input files compile cleanly on their own, or lower **Math markup in diffs** to equation-level or suppress markup.
- **Git commit diff fails or shows no commits**: Confirm the workspace is a Git repository, click the refresh icon (<wa-icon library="texra" name="refresh"></wa-icon>) next to **Commit**, and verify the file existed at the selected commit under the same relative path.

## Best practices

**Before comparing**, run a formatter (`latexindent` or `tex-fmt`) on both documents. Consistent indentation and line breaks keep `latexdiff` from flagging pure-whitespace changes.

**When reviewing**:

1.  **Compile first**: Compile the generated `_diff.tex` document to see the rendered changes (as shown in the slice at the top of this page). TeXRA does this automatically using LaTeX Workshop if it is installed. Live examples are embedded below.

2.  **VS Code diff view**: For a quick source-level comparison, pick the original (`draft.tex`) as the base file and the generated diff source (`draft_diff.tex` for a project diff, `draft-diff<hash>.tex` for a commit diff, or `draft_diffr1r0.tex` between revisions) as the edited file, then press **Compare** in the **latexdiff** sheet. This opens both files side by side in VS Code's diff editor, as shown below.

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

- [File management](/guide/file-management): organize your files
- [Best practices](/guide/best-practices): recommended workflows using diff features
