# Design red flags by lens (read-only): the flags the area audits did not search

Rounds 1 to 3 (`../2026-11-05-design-red-flags/`,
`../2026-11-06-design-red-flags-round-2/`,
`../2026-11-07-design-red-flags-round-3/`) audited every source directory,
one area per auditor, against one list of red flags: shallow module,
information leakage, temporal decomposition, overexposure and pass-through,
special and general mixed, conjoined names, state in optional fields,
reinvented primitives, errors not defined out of existence, two
representations, comments substituting for design, change amplification.

Several of Ousterhout's red flags (_A Philosophy of Software Design_, the
summary of red flags and chapters 6, 7, 12 to 14 and 18) were on no
auditor's list, or only by file name. An area audit also cannot see a flag
whose instances sit in many areas. Each lens below is audited across the
whole repo by one auditor.

## Rules

The rules and the output format are round 2's
(`../2026-11-06-design-red-flags-round-2/BRIEF.md`), with these changes:

- **Scope.** Your scope is the whole repo's source: `packages/*/src`, the
  repo-root `src/` support only where your lens is about tests, and
  `scripts/` only where your lens is about tooling. Sample with grep, then
  read the strongest instances in full.
- **Findings.** Aim for the 6–12 strongest, each with its consumer counts.
  A lens that finds the code mostly fine says so: an honest "few
  instances" is a result.
- **No repeats.** A finding already in any round-1, round-2 or round-3
  report, in the round-2 order note
  (`.agents/docs/proposed/architecture/2026-11-07-red-flags-round-2-and-order.md`),
  the round-3 plan (`2026-11-07-red-flags-round-3-plan.md` beside it), the
  root designs note (`2026-11-05-root-designs-effect-native.md`) or
  `.agents/docs/refuted-candidates.json` is found: cite it, do not repeat
  it. Grep the evidence folders for a symbol before reporting it.
- **In-flight PRs.** Packages A to F are changing code in parallel (the
  round-3 plan's table). A finding in a file an open PR rewrites names that
  PR's number.
- **Effect-native mapping.** End with the round-2 mapping table, every API
  checked in `node_modules/effect` (4.1.2) `.d.ts`. There is no
  `Layer.scoped`; `Layer.effect` provides a `Scope`.
- **Commit.** State the main commit you read at the top.

## Lenses

| Report                  | Lens and what to look for                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass-through.md`       | **Pass-through variables and decorators (ch. 7).** A parameter, options bag or context object threaded through layers that do not use it, only to reach one deep reader; a wrapper or decorator that adds nothing but forwarding; an interface method that restates the one below it. For each, the better carrier: a `Context.Service` or `Context.Reference` the deep reader yields, or a value captured where it is made.       |
| `interface-comments.md` | **Interface comments (ch. 12, 13).** Implementation detail in a public or exported interface's doc; a comment that repeats the code; a deep module with no interface comment; an interface comment that has to be long, which is Ousterhout's "hard to describe": the abstraction is wrong. False comments are defects; list each with its line. Report the worst files' comment shares.                                           |
| `names.md`              | **Names (ch. 14).** A name that is hard to pick because the thing does two jobs; one name for two different things across packages; two names for one thing; vague names (`data`, `info`, `manager`, `handler`, `helper`, `util`, `result`, `state`, `context`) on things that have a precise job; names the root `AGENTS.md` "Plain names and comments" table forbids. Persisted and wire strings keep their spelling.            |
| `nonobvious-code.md`    | **Nonobvious code (ch. 18).** Correctness that depends on an ordering, a timing or a fact stated far away; event-driven indirection whose handler is hard to find; generic containers (tuples, `Record<string, unknown>`, positional arrays) where a named type would say what each part is; mutation of an argument; code whose meaning needs the commit history. Also `as` casts that hide a missing check.                      |
| `temporal-conjoined.md` | **Temporal decomposition and conjoined code (ch. 5, 9).** One operation split by when things happen (`prepare` / `run` / `finish`, `init` / `start` / `complete`, a "before" hook and an "after" hook that share state); two functions or modules that cannot be understood apart (one sets what the other reads, a flag passed between them); a sequence of calls every caller must make in order.                                |
| `general-special.md`    | **General and special purpose (ch. 6).** An interface shaped around one caller (one method per caller's case, a parameter only one caller passes); a general module with branches for one caller's case; the opposite too: a "general" layer with one user that adds only a name. For each, the somewhat-general interface that serves every caller with fewer methods.                                                            |
| `catalogue.md`          | **The catalogue.** Not a new search. Every finding of rounds 1 to 3 (and the R1 to R10 roots), tagged with Ousterhout's red flags, its package and its status: landed (PR number), in a package (which), refused (refused-candidate id) or open with no owner. Then counts by flag, by package and by status; the flags that cluster in one package; and every open finding with no owner. Read PR numbers from `git log` on main. |
