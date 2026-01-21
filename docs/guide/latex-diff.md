# LaTeX Diff

TeXRA uses `latexdiff` to show changes between document versions with proper LaTeX syntax awareness. Diff files are generated automatically after agents modify `.tex` files.

## The LaTeXdiffs Section

Access diff functionality through the "LaTeXdiffs" section in the TeXRA interface:

- **Base File**: Original document
- **Edited File**: Modified version
- **latexdiff Button**: Generate diff between two files
- **Git Commit**: Compare with previous Git versions
- **Merge Button**: Intelligently merge changes (see [Intelligent Merge](./intelligent-merge.md))

## Comparing Two Files

1. Select the original in "Base File" dropdown
2. Select the modified version in "Edited File" dropdown
3. Click the "latexdiff" button

TeXRA generates a `_diff.tex` file with highlighted changes and triggers LaTeX Workshop (if installed) to compile and display the PDF.

### Between-Round Diffs

By default, TeXRA only creates diffs comparing each round to the original. Enable between-round diffs (`_diff_rN-rM.tex`) in settings:

```
texra.latexdiff.generateBetweenRoundDiffs: true
```

## Git-Based Comparison

1. Select a base file
2. Choose a commit from the "Commit" dropdown
3. Click "latexdiff-vc"

TeXRA compares your file with its version at that commit.

**Managing outputs:**
- **Pack**: Archive diff files
- **Clean**: Remove diff files

## Understanding Diff Output

Changes are marked with:
- **Additions**: `\DIFadd{text}` - typically blue/underlined
- **Deletions**: `\DIFdel{text}` - typically red/struck-through

## Diff Examples

- [Original vs. Round 0](/examples/draft_polish_r0_gemini25p_diff.pdf)
- [Original vs. Round 1](/examples/draft_polish_r1_gemini25p_diff.pdf)
- [Round 0 vs. Round 1](/examples/draft_polish_r1_gemini25p_diffr1r0.pdf)

## Troubleshooting

**Diff doesn't compile**: Check for conflicting markup or unclosed environments in the source.

**No commits in dropdown**: Verify the file is in a Git repo and refresh the list.

**Missing highlights**: Ensure both documents are valid LaTeX; complex structures may confuse latexdiff.

## Next Steps

- [Intelligent Merge](/guide/intelligent-merge) - Combine changes intelligently
- [File Management](/guide/file-management) - Organize files effectively
