# Design red-flag audit, 2026-11-15 (read-only): every area, then every flag

Read on `main` at `d70ad92`. Rounds 1 to 7 and two lens audits
(`../2026-11-05-design-red-flags/` to `../2026-11-08-design-red-flags-lenses-2/`)
found 370 ids, catalogued in
`../2026-11-07-design-red-flags-lenses/catalogue.md`; most have landed. This
round reads the tree as it stands after them. It has two halves: eleven area
auditors, each reading one area against every red flag, and five lens
auditors, each reading the whole repo for one group of flags. The findings
are compiled into `catalogue.md` in this folder; one owner per package then
builds its rows in one PR.

## Rules

You audit `/home/user/TeXRA` for design problems in the sense of Ousterhout,
_A Philosophy of Software Design_, with the root `AGENTS.md` "Design
guardrails" as the yardstick. For each one, propose the design that makes it
disappear.

- **Read-only.** Edit no file except the one report your task names, in this
  folder. Run no build, test, install or git-mutating command. Read with
  Read/Grep or `sed`/`grep`/`git log`/`git show`.
- **Read first:** the root `AGENTS.md` whole, and the nested guide for your
  area (`packages/harness/AGENTS.md`, `packages/texra/AGENTS.md`,
  `packages/extension/src/AGENTS.md`, `src/test-kernel/AGENTS.md`).
- **No repeats.** Before reporting a finding, grep its main symbols and file
  names in `.agents/docs/evidence/`, `.agents/docs/proposed/` and
  `.agents/docs/refuted-candidates.json`. A finding an earlier report made is
  found: if the code still shows it and the earlier catalogue has it as
  landed, report it as a **regression or remainder** and say which id; if it
  is held or refused, leave it alone and list it under "Already settled". A
  refused candidate is reported again only with evidence the refusal did not
  have.
- **Open PRs.** Seven PRs are open and rewrite files:
  `/tmp/claude-0/-home-user-TeXRA/a8a22883-14ca-59fd-9433-aee551bf6a69/scratchpad/open-pr-files.txt`
  lists every file each touches (`#number path`). Their branches are fetched
  (`git branch -r`). For a finding in a listed file, read
  `git diff origin/main...origin/<branch> -- <path>` first; if the PR already
  fixes it, drop the finding. If it does not, report it and name the PR.
- **Evidence.** Cite every claim as `path:line`, read at `d70ad92`. Grep the
  consumer count of every symbol you propose to delete or collapse
  (production: `packages/*/src`; other: `src/`, `packages/*/test`, `docs/`).
  Check an Effect, SQLite or Node API in `node_modules` before proposing it.
- **Verify before you write.** Half of all audit candidates die on a second
  read. For each finding, read the whole of the code involved, not the grep
  hit, and try to refute it: is there a second caller, a host that differs, a
  boundary that needs the shape, a dated note that decided it? Report only
  what survives. A thin area says so: "few instances" is a result. Do not
  pad.
- **Size.** Aim for the 6 to 14 strongest findings. Batch small instances of
  one problem into one finding that lists every instance. A finding is a
  design problem with all its instances, not one line.
- **Bugs.** A real defect you meet (wrong behavior, a lost error, a false
  comment) is a finding too; mark it `kind: bug` and say how it fails.

## The red flags (name them in each finding)

Use these names exactly, so the catalogue can count them:

| Flag                   | What to look for                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shallow module         | interface nearly as large as the implementation; a file of one-step exported helpers; a class whose methods are getters; a single-caller extraction; a port with one implementation           |
| information leakage    | a protocol, id format, file layout, message shape or gate known by several modules; one fact with two owners; two representations of one fact                                                 |
| temporal decomposition | one operation split by when things happen (prepare / run / finish); a sequence of calls every caller must make in order                                                                       |
| overexposure           | an export with no consumer or only test consumers; an option, flag, mode or table column that is constant or derivable; a public type wider than its consumers need                           |
| pass-through           | a method, module, re-export or wrapper that only forwards; a variable threaded through layers to one deep reader                                                                              |
| repetition             | the same code, table, literal list, guard or decode at several sites; a hand-written version of what Effect, SQLite, Node or an installed package provides                                    |
| special-general mixed  | a general path with a branch for one caller; a general module that names one plugin, host or provider; an error kind or reason literal nothing branches on                                    |
| conjoined methods      | two functions or modules that cannot be understood apart: one sets what the other reads, a flag passed between them; state in optional-field combinations where a tagged type would carry it  |
| comment restates code  | a comment that repeats the name or type; a comment that explains a hand-off protocol the structure should carry; a false comment; a citation of a document in place of a reason               |
| vague name             | `data`, `info`, `manager`, `helper`, `util`, `result`, `state`, `context` on something with a precise job; one name for two things; two names for one; a word the "Plain names" table refuses |
| non-obvious code       | correctness that depends on an ordering, timing or far-away fact; an `as` cast hiding a missing check; a generic container where a named type would say what each part is; silent degradation |

"Silent degradation is a defect" (`catch {}`, `??` over a failed read,
`catchDecoding` on persisted data, a `default: return` that drops an unknown
event) is filed under non-obvious code with `kind: bug`.

## Output

Write your report to the file your task names. Start with the commit and a
short "Numbers" section (lines per subdirectory, the five largest files).
Then one section per finding, with ids `<PREFIX>-1`, `<PREFIX>-2`, …:

```
## <ID>: <what is wrong, in plain words>

- flags: <one or more names from the table>
- package: <harness | texra | llm | cli | desktop | extension | trace-viewer | root>
  (the package that owns the files that change most; name the others it touches)
- kind: <refactor | bug | docs>
- size: <S under 100 changed lines | M 100 to 400 | L over 400>
- earlier: <"none", or the earlier id and what remains>
- open PR: <"none", or the number and what it leaves>

**Evidence.** path:line citations, consumer counts, a quoted line or two.
**The design decision behind it.** The question the code answers in several
places or in the wrong place.
**The better design.** The one owner or structure; what is deleted (symbols
with counts); what callers write afterwards.
**What we give up, and risk.**
**How I tried to refute it.** What you checked that could have killed it.
```

Then "Good modules in this area" (deep modules worth copying, briefly) and
"Already settled, left alone" (with the citation).

Return, as your final message, only a table with one row per finding:
`id | package | flags | kind | size | one-line title`, and one line saying how
many candidates you dropped on verification.

## Areas

| Prefix | Report                  | Scope                                                                                                                                                              |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HR     | `HR-harness-runtime.md` | `packages/harness/src/agent/runtime/`, `agent/codeSandbox/`, `agent/core/`, `agent/followUp/`, `agent/prompt/`, `agent/trace/`, `model/`                           |
| HS     | `HS-harness-store.md`   | `packages/harness/src/shared/`, `effect/`, `agent/storage/`, `agent/index/`, `agent/memory/`, `agent/workspaceAgents/`, `transcript/`, `controllers/`, the entries |
| HT     | `HT-harness-tools.md`   | `packages/harness/src/tools/`, `platform/`, `utils/`, `common/`, `logger/`, `skills/`, `types/`                                                                    |
| TC     | `TC-app-controllers.md` | `packages/texra/src/controllers/`, `agent/`, `hosts/`, `platform/`, `model/`, `common/`, `utils/`, `telemetry/`, `housekeeping/`, `shared/`                        |
| TT     | `TT-app-tools.md`       | `packages/texra/src/tools/`, `latex/`, `replacement/`                                                                                                              |
| TU     | `TU-app-ui.md`          | `packages/texra/src/ui/`                                                                                                                                           |
| CL     | `CL-cli.md`             | `packages/cli/src/`                                                                                                                                                |
| DT     | `DT-desktop.md`         | `packages/desktop/src/`, `packages/trace-viewer/`                                                                                                                  |
| EX     | `EX-extension.md`       | `packages/extension/src/`, `packages/extension/resources/` (agent YAML and prompts as design, not prose)                                                           |
| LM     | `LM-llm.md`             | `packages/llm/src/`                                                                                                                                                |
| RT     | `RT-root-tooling.md`    | `scripts/`, `src/test-kernel/` and the other repo-root `src/` suites, `packages/*/test` support, `oxlint.config.mts`, build and CI config, `.github/workflows/`    |

## Lenses (whole repo: `packages/*/src`, and `scripts/` or tests only where the flag is about them)

| Prefix | Report                         | Flags                                                                                                                             |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| LS     | `LS-shallow-passthrough.md`    | shallow module, pass-through, overexposure (count each export's consumers; `packages/harness/docs/api/` shows the public surface) |
| LI     | `LI-leakage-repetition.md`     | information leakage, repetition, across package boundaries first: one fact decided in two packages, hand-written library code     |
| LT     | `LT-temporal-conjoined.md`     | temporal decomposition, conjoined methods, special-general mixed, and options that are decisions the code refused to make         |
| LC     | `LC-comments-names.md`         | comment restates code, false comments, document citations in code, vague names, the "Plain names" table                           |
| LN     | `LN-nonobvious-degradation.md` | non-obvious code, silent degradation, casts hiding checks, Promise or timer code where Effect is the rule, shared mutable state   |

A lens auditor samples with grep across every package, then reads the
strongest instances in full. An area auditor reads its area's files. The two
halves will overlap; the catalogue merges the duplicates.
