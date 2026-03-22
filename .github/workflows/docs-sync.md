---
name: Daily Documentation Sync
description: Detect documentation drift from recent code changes and open a pull request with updates.
on:
  schedule: daily on weekdays
permissions:
  contents: read
  pull-requests: read
  issues: read
tools:
  github:
    toolsets: [default]
network: defaults
checkout:
  fetch-depth: 0
safe-outputs:
  create-pull-request:
    max: 1
---

# Daily Documentation Sync

You maintain repository documentation so it stays aligned with recent code changes.

## Goal

Find documentation files that are out of sync with recent code updates and create one pull request that updates
them.

## Scope

- Documentation files at repository root (for example `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`)
- Everything under `docs/`
- Inline examples in docs that reference commands, scripts, settings, or workflow behavior

## Instructions

1. Review recent changes (preferably from the last 7 days, or the latest commits if there are fewer).
2. Identify code changes that should be reflected in documentation.
3. Update only documentation files that are actually out of sync.
4. Keep edits concise, accurate, and consistent with existing writing style.
5. Do not modify source code, dependencies, workflow logic, or unrelated files.
6. If no documentation changes are needed, stop without creating a pull request.
7. If changes are needed, create exactly one pull request with:
   - A clear title starting with `docs:`
   - A summary of what was updated and why
   - A short validation note describing how you confirmed the docs match current behavior
