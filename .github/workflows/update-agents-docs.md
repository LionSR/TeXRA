---
on:
  schedule: weekly
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

engine: copilot

tools:
  github:
    mode: remote
    toolsets: [default]

network: defaults

safe-outputs:
  create-pull-request:
    max: 1

---

# Weekly AGENTS/CLAUD documentation maintenance

You maintain repository guidance docs so they stay accurate with recent changes.

## Goal

Review merged pull requests and source updates since the previous successful run, then update documentation guidance as needed and open one pull request.

## Scope

- Required: `AGENTS.md`
- Required: `CLAUD.md` when present, otherwise `CLAUDE.md`
- If both `CLAUD.md` and `CLAUDE.md` exist, keep both accurate and synchronized

Do not modify unrelated files.

## Process

1. Determine the review window.
   - Find the previous successful run of this workflow in this repository.
   - Use that run's completion time as the `since` boundary.
   - If no previous successful run exists, use the last 7 days.

2. Collect evidence for documentation updates.
   - List pull requests merged since `since`.
   - Review changed files and noteworthy code/doc changes from those PRs.
   - Also review direct commits to the default branch since `since`.

3. Update docs with minimal, concrete edits.
   - Keep existing tone, organization, and conventions.
   - Remove stale instructions and add missing guidance that reflects current codebase behavior.
   - Keep guidance implementation-oriented and verifiable from repository state.

4. Validate before proposing changes.
   - Ensure referenced files, commands, and directories exist.
   - If no documentation changes are needed, do not open a pull request.

5. Open pull request when changes exist.
   - Title: `docs: weekly sync AGENTS.md and CLAUD.md`
   - In the PR body, include:
     - The review window used.
     - Merged PRs and commits reviewed.
     - A concise summary of documentation updates.
