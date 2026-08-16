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
`npm test`, and do not ask the author to add speculative abstractions. Do not
ask the author to add tests beyond the bar in `AGENTS.md` "Testing discipline":
flag a missing test only when the PR fixes a reproduced defect and ships
without its regression test.

Conversely, flag pass-through layers this pull request newly introduces — wrapper
functions that only forward to a single callee, single-use two-layer factories,
trivial identity factories that just spread an object, and re-export shims — per
AGENTS.md's "Flattening abstraction layers" and "Discouraged factory patterns",
and recommend inlining them. Limit this to indirection the PR adds; respect
load-bearing thin layers (dependency-injection seams, multi-caller DRY helpers,
the prescribed PocketFlow `Node.exec() -> createFlow() -> flow.run()` shape),
which are thin by design rather than redundant.

Before posting new feedback, read existing inline review threads and PR comments.
Avoid re-raising issues that are already discussed, acknowledged, or fixed. On
re-review runs (triggered by the `re-review` label), resolve previous unresolved
bot review threads only when the new commits actually address them; never
resolve human review threads.

For each concrete issue, post an inline comment on the relevant line. At the end,
post a concise PR-level summary in the format required by the local review skill,
including a `Verified` section with the files and line ranges actually opened.
