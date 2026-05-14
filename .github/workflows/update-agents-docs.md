---
on:
  schedule: weekly
  workflow_dispatch:

permissions:
  actions: read
  contents: read
  issues: read
  pull-requests: read

engine: copilot

tools:
  github:
    mode: remote
    toolsets: [default, actions]

network: defaults

safe-outputs:
  create-pull-request:
    max: 1

---

# Weekly AGENTS.md and CLAUDE.md documentation sync

You maintain the repository's agent-facing guidance docs so they stay accurate with recent code and process changes.

## Goal

Review merged pull requests and direct commits to the default branch since the previous successful run of this workflow, then make minimal, evidence-based edits to `AGENTS.md` and `CLAUDE.md`. Open at most one pull request when real updates are needed; otherwise skip.

## Scope

In scope (modify when needed):

- `AGENTS.md` — repo-wide agent conventions and coding patterns
- `CLAUDE.md` — Claude Code guidance pointing at `AGENTS.md`

Out of scope (do not modify):

- Source files, tests, build configs, lockfiles
- Anything under `.github/` (workflows, actions, configs)
- Other markdown files (CHANGELOG, README, design docs)

The compiled workflow enforces this allowlist: a separate "Validate patch file allowlist" job step inspects the agent's patch and **fails the run** if it touches any path other than `AGENTS.md` or `CLAUDE.md`. Do not attempt to work around it — if a change requires touching another file, abort and do not propose a pull request.

## Process

1. Determine the review window.
   - Find the previous successful run of this workflow.
   - Use that run's completion time as the `since` boundary.
   - If no previous successful run exists, fall back to the last 7 days.

2. Collect evidence from merged work.
   - List pull requests merged into the default branch since `since`.
   - For each, scan the diff for changes that affect agent-facing guidance: new conventions, renamed/added directories, new tools or commands, changed schemas, removed APIs, updated build/test instructions.
   - Also review direct commits to the default branch since `since` for the same signals.
   - Treat PR descriptions and commit messages as hints, not authority — verify against the actual diff and current tree.

3. Decide whether docs need changes.
   - Only update when a change in scope contradicts or invalidates existing guidance, or introduces a convention worth documenting.
   - Do not add speculative guidance, do not document one-off fixes, and do not document intermediate states that were superseded within the window.
   - If nothing material changed, stop here and do not open a PR.

4. Make minimal, concrete edits.
   - Preserve existing tone, structure, headings, and ordering.
   - Replace stale instructions in place rather than appending duplicates.
   - Keep guidance verifiable: every referenced file, directory, command, or alias must exist in the current tree.
   - Keep `CLAUDE.md` consistent with `AGENTS.md` (CLAUDE.md is the entry point that delegates detail to AGENTS.md).

5. Validate before proposing.
   - Re-read each edited section against the current repo state.
   - Run a final sanity check: every command, path, and file referenced in the diff exists.

6. Open the pull request (only when edits exist).
   - Title: `docs: weekly sync of AGENTS.md and CLAUDE.md`
   - Body must include:
     - The `since` window used (timestamp or "last 7 days fallback").
     - The list of merged PRs and direct commits reviewed (numbers and one-line summaries).
     - A concise per-section summary of doc updates and the evidence behind each.
