Review this TeXRA pull request.

Step 0: Load the local review instructions before doing anything else.

1. Read `.claude/skills/code-review/SKILL.md`.
2. Read `.claude/skills/code-review/references/review-checklist.md`.
3. Consult `CLAUDE.md` and `AGENTS.md` for the repository rules referenced by
   the changed files.

Get the diff with `gh pr diff`, then group changed files by the architectural
zones described in the review skill. For PRD or documentation-only diffs, review
the document as the product: check claims against the current tree and avoid
irrelevant TypeScript findings.

Prioritize correctness, security, platform decoupling, type safety, Zod v4
schema correctness, PocketFlow invariants, webview lifecycle issues,
configuration and storage correctness, and CI/toolchain hygiene. Do not run
`npm test`, and do not ask the author to add speculative abstractions.

Before posting new feedback, read existing inline review threads and PR comments.
Avoid re-raising issues that are already discussed, acknowledged, or fixed. On
`synchronize` events, resolve previous unresolved bot review threads only when
the new commits actually address them; never resolve human review threads.

For each concrete issue, post an inline comment on the relevant line. At the end,
post a concise PR-level summary in the format required by the local review skill,
including a `Verified` section with the files and line ranges actually opened.
