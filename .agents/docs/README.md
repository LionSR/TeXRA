# Agent Notes

This tree is the home for the project's design notes: PRDs, proposals, plans,
and audits. It merges the former `docs/prds/` and `docs/proposals/` directories
into a single lifecycle-organized hierarchy.

## Layout

```
.agents/docs/{lifecycle}/{class}/yyyy-mm-dd-topic.md
```

Every note is a single markdown file named with its date and a kebab-case
topic. Multi-file efforts (supporting assets, mockups, manifests) live in a
directory named after the note, at the same level.

## Lifecycles

- `proposed/` — a direction under consideration; nothing here is committed to.
- `implemented/` — landed and still describing how things work today.

A note that is rejected, superseded or fully settled is deleted, not filed:
version-control history keeps it, and a ruling worth keeping as a constraint
goes in the rulings ledger or `config/ratchets/refuted-candidates.json`.

## Classes

The class set is closed — do not add new top-level class directories:

- `feature/` — new user-visible capability or behavior.
- `bug-fix/` — diagnosis and fix plan for a defect.
- `simplification/` — deletion, consolidation, or complexity-reduction work.
- `architecture/` — structural design: boundaries, ownership, protocols.
- `process/` — how the project works: releases, reviews, tooling, workflow.
- `testing/` — test strategy and test-infrastructure design.

## Status markers

Every note carries a status marker. Files with YAML frontmatter use a
`status:` key; other files carry a `Status: <status>` line directly after the
first heading.

The status is typed, not derived, so `scripts/check-proposal-status.mjs` (CI,
in the ungated `guidance references` job) fails when a note under `proposed/`
declares itself done and has not moved: its status line names a settled
lifecycle (`implemented`, `landed`, `superseded`, `rejected`, …), or it has a
`Landed` section and no section saying what is still open. Citing a merged PR
as evidence or as a prerequisite is not a completion marker — a proposal may
rest on landed work and stay open.

## Conventions

- [`INDEX.md`](./INDEX.md) is the one allowed index, and it indexes owners,
  not files: one row per topic naming the note that owns it. It exists because
  a tree of 29 dated notes cannot say which of six notes on a topic is the
  current one. Do not add a second index, a per-class index, or a file listing
  — for everything without an owner, the directory tree and git history remain
  the index.
- Cross-references between notes use relative markdown links.
- Shared binary/figure assets live in `.agents/docs/figures/`; measurement and
  reproduction artifacts live in `.agents/docs/evidence/`, and only while a
  live note cites them.
