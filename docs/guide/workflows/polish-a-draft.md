# Polish a draft

Once the results are in, a polish rewrites a LaTeX draft for clarity while
keeping the math, the citations and the structure. There is no polish
program: ask the assistant.

## Ask for it

In the TeXRA panel or `texra` in a terminal:

```
Polish section 2 of main.tex for clarity and flow. Keep every equation, label and citation as it is. Compile when you are done and show me a latexdiff against the version in git.
```

From a script or CI:

```bash
texra run chat --instruction "Proofread paper.tex: fix typos, grammar and LaTeX syntax only. Compile it with latexmk."
```

The assistant edits the file in place with its file tools, compiles it with
`latexmk`, and runs `latexdiff` when you ask for a marked-up PDF. Each edit
asks for approval under your [approval policy](../configuration.md), with a
preview of the change.

## Getting a careful result

- **Commit first.** The edits land in your files; `git diff` shows them and
  `git checkout` undoes them.
- **Say how far to go.** "Proofread" changes wording and formatting; "polish"
  may rewrite sentences and paragraphs; "expand the derivation of (12)" adds
  content.
- **Ask for a second look.** "Then review your changes against the original
  and revert any the instruction did not ask for" has the assistant check
  its own work, with a fresh helper agent if you ask for one.
- **Ask for alternatives.** "Try this three ways in separate copies and keep
  the best" has it work in copies of the project and write only the winner.

## See also

- [The assistant and programs](../programs.md): `annotate` reviews a draft
  without rewriting it
- [LaTeX diff](../latex-diff.md): what the marked-up PDF shows
