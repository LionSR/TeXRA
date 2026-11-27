# LaTeX diff

`latexdiff` marks what changed between two versions of a LaTeX document:
additions in blue, deletions in red. TeXRA uses it in two places.

## Ask the assistant

There is no diff panel. Ask in plain words, and the assistant runs
`latexdiff` (or `latexdiff-vc` against a git commit) in the shell and
compiles the result:

```
Write the latexdiff from old.tex to new.tex into diff.tex and compile it.
```

```
Show me a latexdiff PDF of main.tex against the last commit.
```

Run a formatter (`latexindent` or `tex-fmt`) on both versions first:
consistent indentation and line breaks keep `latexdiff` from marking
whitespace.

## Edit previews

When an edit to a `.tex` file waits for your approval, TeXRA can show it as
a compiled latexdiff. Two settings under **Settings → LaTeX** shape that
preview:

- **Math markup in diffs** (`texra.latexdiff.mathMarkup`): how changes
  inside math environments are marked.
- **Only changed pages in diff PDFs** (`texra.latexdiff.changesOnly`): keep
  only the pages that hold a change.

`latexdiff` needs a TeX distribution; read [Installation](./installation.md).

## Next steps

- [Polish a draft](./workflows/polish-a-draft.md)
- [LaTeX tools](./latex-tools.md)
