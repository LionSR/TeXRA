# Design red-flag audit, round 7 (read-only): fallbacks

Rounds 1 to 6 (`../2026-11-05-design-red-flags/` to
`../2026-11-07-design-red-flags-round-6/`) and the lens audits
(`../2026-11-07-design-red-flags-lenses/`) audited by directory, by lens and by
area. Round 7 is one lens across the whole repository: **fallbacks**, every
place where a failure, an absence or an unknown case becomes a default
instead of being surfaced. It starts from the owner's observation that "many
of the fallbacks look like red flags too."

## Scope

Production sources under `packages/*/src` (no `*.test.*` file) and the bundled
resources under `packages/extension/resources/`. Tests are evidence (does a
test exercise the degraded path?), not scope.

Shapes searched, with counts in the report: bare `catch {`, `Effect.ignore`,
`orElseSucceed`, `catchDecoding`, `catchTag` / `catchIf` / `catchCause` /
`Effect.catch` handlers that succeed with a default, `Option.getOrUndefined` /
`getOrElse`, `?? []` / `?? ''` / `?? null` / `?? undefined` (sampled by module),
`default:` branches, `Promise.allSettled`, retries that drop the last error, and
every path the code itself calls a fallback.

## Rules

Round 2's red flags and output format
(`../2026-11-06-design-red-flags-round-2/BRIEF.md`) with round 6's additions
(`../2026-11-07-design-red-flags-round-6/BRIEF.md`): the commit read is stated
at the top; every citation is `file:line` on that commit; a finding already in
an earlier round, a lens report, the catalogue
(`../2026-11-07-design-red-flags-lenses/catalogue.md`) or
`.agents/docs/refuted-candidates.json` is cited, not repeated; the report ends
with an Effect-native mapping and an owner per finding.

Each fallback is judged against `AGENTS.md` "Silent degradation is a defect",
"No option for a special case" and "Defaults are not interchangeable", and
against the accepted exceptions of
`.claude/skills/code-review/references/review-checklist.md` §15 (L1 to L5). It
is one of:

- a **real alternative** decided from a fact the code holds (not a finding;
  instructive ones go in "Good, left alone");
- **silent degradation**: a failure or corruption becomes a default with no
  warn log and nothing surfaced (a **defect** where reachable today);
- a **special case written as an option or a branch**;
- an **error not defined out of existence**: a different shape of the
  operation would make the fallback unnecessary;
- **two policies for one failure**: a fix left the old fallback beside the new
  path.

## What this round adds

- Ids `FB1`, `FB2`, ... in ranked order, small items of one kind batched under
  one id with lettered parts, so each id can become one catalogue row.
- The area's questions answered first: fallbacks by shape and package, how
  many warn before degrading, how many have a test of the degraded path, which
  fire on the main path today, and which recorded compromises are fallbacks
  whose reason is gone.
- A "Good, left alone" section naming the §15 exception each borderline
  fallback matches.

Report: [`REPORT.md`](REPORT.md).
