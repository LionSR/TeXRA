# Agent Notes

This tree is the home for the project's design notes: PRDs, proposals, plans,
and audits. It merges the former `docs/prds/` and `docs/proposals/` directories
into a single lifecycle-organized hierarchy.

## Layout

```
agents/docs/{lifecycle}/{class}/yyyy-mm-dd-topic.md
```

Every note is a single markdown file named with its date and a kebab-case
topic. Multi-file efforts (supporting assets, mockups, manifests) live in a
directory named after the note, at the same level.

## Lifecycles

- `proposed/` — a direction under consideration; nothing here is committed to.
- `implemented/` — landed and still describing how things work today.
- `rejected/` — considered and deliberately not taken; kept so the reasoning
  is not lost. The status line records why.
- `archived/` — frozen, settled records (see "Archive policy" below).

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
first heading. Rejected notes record the reason on that line
(`Status: rejected — <reason>`).

## Archive policy

`archived/{class}/` holds frozen, settled records. Each carries an
`Archived: yyyy-mm-dd` marker (or `archived:` frontmatter key) recording when
it was frozen. Archived content is not authority for current behavior — it may
describe code that has since changed or been deleted. Active prose may link
into the archive as history, but never cite it as current design.

When an active note is superseded or settles, move it to `archived/` with
`git mv`, keep its class directory, and add the archive marker.

## Conventions

- There is no centralized INDEX file; the directory tree and git history are
  the index.
- Cross-references between notes use relative markdown links.
- Shared binary/figure assets live in `agents/docs/figures/`; measurement and
  reproduction artifacts live in `agents/docs/evidence/`.
