# Design red-flag audit, round 4 (read-only): what no audit read, and what today's PRs left and added

Rounds 1 to 3 (`../2026-11-05-design-red-flags/`,
`../2026-11-06-design-red-flags-round-2/`,
`../2026-11-07-design-red-flags-round-3/`) and the lens audits
(`../2026-11-07-design-red-flags-lenses/`) read every directory under
`packages/*/src`. Round 4 reads three things they did not: the directories
outside that tree, the compromises the PRs merged on 2026-11-07 accepted,
and the red flags those PRs' added lines brought in.

The rules, the red-flag species and the output format are round 3's
(`../2026-11-07-design-red-flags-round-3/BRIEF.md`), with three changes:

- Each report is read at main `363d484` (#14807, the last merge before the
  audit) and says so at its top. A PR that merged after that commit, or is
  still open, is listed with what its body leaves, and its code is not
  checked.
- A finding already in an earlier round, a lens audit, the catalogue
  (`../2026-11-07-design-red-flags-lenses/catalogue.md`), the round-3 plan
  or `.agents/docs/refuted-candidates.json` is found: cite it, do not
  repeat it.
- The report ends with an owner for each finding, by the round-3 plan's
  packages (A to F), or "owner's call" where the decision is the owner's.

## Areas

| Area | Report                            | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W    | held until its fixes are deployed | The directories no audit read: `supabase/functions/` (the edge functions and `_shared/`, with the client halves of their contracts, on `main` and on `release/0.40`, where most clients live); the Lean 4 plugin's agents and skills (`packages/extension/resources/plugins/lean4/`); and `packages/desktop/build/` with the electron-builder configs beside it. Key questions: one fact computed on both sides of a wire; a wire with no check between its halves; a prompt that has drifted. |
| X    | `X-compromises-today.md`          | The compromises today's PRs accepted, read the way V read round 3's: the "Left", "Not done", "Kept" and "Refused" sections of #14799, #14801, #14802, #14805, #14806, #14807, #14809 and #14810, their review threads, the `refuted-candidates.json` entries added since `ca1431e`, and the two PRs still open when the audit began, #14808 and #14811. Key questions: was the reason ownership, order or scope, or the design itself; does it still hold; what is the best design today.      |
| Y    | `Y-added-today.md`                | The red flags today's merged diffs added: only the added lines and the new or rewritten modules of `ca1431e..363d484`. A flag a PR removed is not listed. Key questions: a rule stated twice; a fix that left the old path beside the new one; an option or failure branch nothing exercises; an export with one consumer or none.                                                                                                                                                             |
