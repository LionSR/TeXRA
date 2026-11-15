# Design red-flag audit, 2026-11-15 (read-only brief)

You audit one slice of this repo for design problems in the sense of
Ousterhout, _A Philosophy of Software Design_, measured against the root
`AGENTS.md` "Design guardrails". Read on `main` at `cb22acd`.

Do not edit any source file. Do not run builds or tests. Read with Read and
Grep (or cat, sed, grep, `git log`, `git show`). The only file you write is
the report named in your task, in this folder.

## Read first

- `AGENTS.md`: "Design guardrails", "Plain names and comments", "Effect",
  "Effect Schema Patterns", "TeXRA 1.0 direction".
- The nested guide of the package you audit
  (`packages/harness/AGENTS.md`, `packages/texra/AGENTS.md`,
  `packages/extension/src/AGENTS.md`).

## The red flags (name the flag on every finding)

shallow module; information leakage; temporal decomposition; overexposure;
pass-through (method, module or variable); repetition (a fact or rule with
two owners); special and general code mixed; conjoined methods; a comment
that restates the code or is false; a vague name; non-obvious code. From the
guardrails also: an option for a special case; silent degradation; a
hand-written version of what Effect, SQLite or Node provides; a
compatibility reader or alias (1.0 keeps none); shared mutable state; a UI
renderer repairing a data-model problem; a single-caller extraction or
identity factory; an export with no consumer.

## No repeats

Seven rounds and two lens audits came before this one. A finding already
recorded is found: do not report it again. Before you report a symbol, grep
for it in:

- `.agents/docs/evidence/2026-11-0*-design-red-flags*/` (the catalogue is
  `2026-11-07-design-red-flags-lenses/catalogue.md`; a row there that says
  `landed` and whose problem you still see in the tree is worth reporting as
  a remainder, with the earlier id);
- `.agents/docs/refuted-candidates.json` (refused: re-propose only on new
  evidence, and say what is new);
- `.agents/docs/proposed/simplification/` and
  `.agents/docs/proposed/architecture/` (open proposals: cite the note and
  report only what it does not list);
- the open PRs. The files each one changes are listed in
  `/tmp/claude-0/-home-user-TeXRA/9fc0012a-7df1-51d7-a0f3-d877b028a4dd/scratchpad/open-prs.txt`.
  A finding in a file an open PR changes names that PR; read the PR's
  version (`git show origin/<branch>:<path>`) and drop the finding when the
  PR already fixes it.

## What counts

- Verify every claim in the source at `cb22acd`. Cite `path:line`. Grep the
  consumer count of every symbol you propose to delete or merge, over
  `packages/*/src` (production) and separately over tests.
- Prefer findings that are instances of one design problem across several
  files over single-line nits. Batch thin items of one species into one
  finding.
- A finding needs a fix that deletes something: a symbol, an option, a
  branch, a file, a second owner. "Rename only" findings belong to the names
  lens.
- Check Effect APIs you cite in `node_modules/effect` (v4); do not cite v3
  from memory.
- A module that is fine is reported as fine. Do not pad. Aim for the 6 to 14
  strongest findings.
- Mark a finding **owner decision** when the fix changes a stored format, a
  published SDK name (`@texra-ai/harness` entry exports), user-visible
  behavior, or picks between two product behaviors.

## Report format

Start with one line: the commit read and the directories covered. Then one
section per finding:

```
### <ID>: <what is wrong, in plain words>

- **Package:** harness | texra | llm | cli | desktop | extension | trace-viewer | repo (tests, scripts, docs)
- **Flags:** <one or more from the list>
- **Evidence:** path:line citations, a quoted line or two, consumer counts
- **Better design:** the owner or structure that replaces it; what callers write afterwards
- **Deleted:** symbols, options, files that stop existing
- **Size:** rough changed lines and files
- **Risk / owner decision:** none, or what must be decided and by whom
```

Ids use the prefix given in your task (`HA-1`, `HA-2`, …). End the report
with:

- **Good modules here** (deep modules worth copying, briefly);
- **Considered and left alone** (with the note, rule or refuted id that
  settles it);
- a summary table `| Id | Title | Package | Flags | Size | Owner decision? |`
  with one row per finding. The orchestrator compiles the catalogue from
  this table, so it must be complete.

Your final message is the summary table plus two or three sentences; the
detail stays in the file.
