# Catalogue: the 2026-11-15 design red-flag audit, by package and status

Every finding of this round's reports, one row each, with the package that owns
the fix, the red flags it names, and its status. The rules the auditors followed
are in [BRIEF.md](./BRIEF.md); each row links the report that holds its evidence
(`path:line`, consumer counts, the better design and what it deletes).

**Read at:** `main` at `cb22acd`. Rows were compiled from each report's summary
table; nothing here adds a code search.

## How the work is owned

One owner session per package, one PR per package against `main`. A row whose
fix crosses packages belongs to the package that owns the fact; that owner
changes the consumers in the same PR. Each owner re-verifies every row on
`main` before building it (a row that no longer holds is dropped with a line in
the PR body), deletes what the fix replaces, adds no tests (a bug fix gets one
regression test written to fail first), runs `npm run gate` and `npm test`, and
fills `.github/PULL_REQUEST_TEMPLATE.md`. Workers never merge; the orchestrator
squash-merges when CI is green, every review thread is answered and `main` is
merged in.

## Statuses

- **assigned:** the package owner builds it.
- **assigned; needs your eye in the PR:** the report marked an owner decision
  that changes a stored format, a published SDK name, a CLI exit code or flag
  spelling, or user-visible text. Before 1.0 such a change is allowed when it is
  the simpler design (root `AGENTS.md`, "Scheduled audits"), so the owner makes
  it in its own commit with a line under "Needs your eye" at the top of the PR
  body, where it can be dropped.
- **held for your call:** a choice between two product behaviors, which neither
  the code nor the rules settle. Not built until decided.
- **landed (#PR)**, **refused (`refuted-candidates.json` id)**: filled in as
  PRs merge and as owners refuse a row on evidence.

## Status at `cb22acd` (compiled 2026-11-16)

Twelve of the eighteen reports are complete. Six stopped at a usage limit
with partial findings saved: `TU` (texra UI), `TL` (texra latex and shared) and
the lenses `LC` (comments and names), `LF` (fallbacks and hand-written code),
`LO` (temporal decomposition and options), `LR` (leakage and repetition). Their
rows are added here when they finish.

| Owner        | Rows | assigned | of which needs your eye | held | landed | refused |
| ------------ | ---: | -------: | ----------------------: | ---: | -----: | ------: |
| harness      |   34 |       32 |                      13 |    2 |      0 |       0 |
| texra        |   24 |       24 |                       6 |    0 |      0 |       0 |
| llm          |    5 |        5 |                       1 |    0 |      0 |       0 |
| cli          |   19 |       19 |                      10 |    0 |      0 |       0 |
| desktop      |   10 |       10 |                       0 |    0 |      0 |       0 |
| extension    |   14 |       14 |                       4 |    0 |      0 |       0 |
| trace-viewer |    1 |        1 |                       0 |    0 |      0 |       0 |
| **all**      |  107 |      105 |                      34 |    2 |      0 |       0 |

`TC2-4` counts as assigned, but open PR #14953 already fixes it; it is closed
when #14953 merges and is not part of the texra owner's PR.

## Held for your call

- **HA-3:** whether a PDF that a tool returns is turned into page images
  when the run's model reads images but not PDFs. Today one path does and
  another does not. The rest of HA-3 (one owner for "does this model take this
  medium") is built either way.
- **HT-10:** whether an approved file edit keeps its write confined through
  `WorkspaceFs`, or writes through the process filesystem the way the matching
  read already does. Removing the `fsPath` spelling convention is built either
  way.

## Every row

| Id | Title | Package | Owner | Flags | Size | Status | Report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HA-1 | Whether a plugin agent's plugin loads is decided twice, and a resume resolves its agent twice | harness | harness | repetition; temporal decomposition | ~120 lines, 5 files | assigned; needs your eye in the PR | [HA](./HA-harness-agent.md) |
| HA-2 | A resume refusal has two wordings; the one keyed by `kind` drops what the refusal carries | harness | harness | repetition; information lost at an interface; silent degradation of a message | ~60 lines, 5 files | assigned | [HA](./HA-harness-agent.md) |
| HA-3 | "Does this model take this medium" is decided at three sites with three answers, and predicted at a fourth | harness | harness | repetition; special and general mixed; conjoined methods; non-obvious code | ~200 lines, 6 files | held for your call: rasterize a tool-result PDF into page images for a vision model, or not | [HA](./HA-harness-agent.md) |
| HA-4 | An awaited child's progress is a callback threaded through nine signatures, restating row facts | harness | harness | pass-through variable; repetition; information leakage | ~160 lines, 12 files | assigned | [HA](./HA-harness-agent.md) |
| HA-5 | `getRunRecords` is four one-field selectors over one row read; a resume reads the run six times | harness | harness | shallow module; temporal decomposition; repetition | ~120 lines, 12 files | assigned | [HA](./HA-harness-agent.md) |
| HA-6 | "Can the helper model serve, else the run's model" written twice; a third availability predicate (D7 remainder) | harness | harness | repetition; hand-written version of an owned predicate | ~45 lines, 3 files | assigned | [HA](./HA-harness-agent.md) |
| HA-7 | The delegation targets are a special prompt section wired through four files beside the general one | harness | harness | special and general mixed; information leakage; repetition | ~90 lines, 5 files | assigned; needs your eye in the PR | [HA](./HA-harness-agent.md) |
| HA-8 | Small items: a fact or knob away from its owner, or with no reader (six items) | harness | harness | shallow module; repetition; export with no consumer; option for a special case; false comment | ~60 lines, 12 files | assigned; needs your eye in the PR | [HA](./HA-harness-agent.md) |
| HP-1 | `RunFileService` is the harness's run-directory reader and the document task's snapshot-and-mirror state in one class | harness (to texra) | harness | special and general mixed, information leakage, repetition, shallow use | ~450 moved, 60 deleted, 20 files | assigned; needs your eye in the PR | [HP](./HP-harness-platform.md) |
| HP-2 | Trust pins an outside file by content for a hook, by size and date for an MCP server | harness | harness | repetition, special and general mixed | ~70 lines, 3 files | assigned; needs your eye in the PR | [HP](./HP-harness-platform.md) |
| HP-3 | `plugin_<plugin>_<server>` is parsed back by a regex that misnames servers of plugins with `_` | harness | harness | information leakage, non-obvious code, defect | ~10 lines, 2 files | assigned | [HP](./HP-harness-platform.md) |
| HP-4 | A plugin's load verdict is judged three times; its refusals are worded again in the app | harness, texra | harness | repetition, conjoined methods | ~60 lines, 5 files | assigned | [HP](./HP-harness-platform.md) |
| HP-5 | `ConfigProvider.inspect` returns an unread `globalValue`; `update` defaults a target its caller always passes | harness | harness | overexposure, option for a special case | ~25 lines, 7 files | assigned; needs your eye in the PR | [HP](./HP-harness-platform.md) |
| HP-6 | Batched: git source built and checked twice, identity rebuild, stray and false comments, two office lists | harness, cli | harness | repetition, false comment, overexposure | ~45 lines, 7 files | assigned | [HP](./HP-harness-platform.md) |
| HS-1 | A call's edited files are written three times on its card and read by nobody | harness | harness | repetition; export with no consumer; constant field | ~40 lines, 6 files | assigned | [HS](./HS-harness-shared.md) |
| HS-2 | Three `log` payload cases have no producer: `scratchpad`, `toolUse`, a text row's `status` | harness, cli, texra | harness | union case nothing produces; special and general mixed; false comment | ~90 lines, 14 files | assigned; needs your eye in the PR | [HS](./HS-harness-shared.md) |
| HS-3 | A compaction's figures ride a second row the transcript hides; three context actions have no producer | harness, texra | harness | repetition; non-obvious code; union cases nothing produces; constant field | ~110 lines, 9 files | assigned; needs your eye in the PR | [HS](./HS-harness-shared.md) |
| HS-4 | Two derived numbers are stored on rows, and the cache-miss count is derived by two rules | harness, texra | harness | repetition; stored derivable field | ~30 lines, 7 files | assigned; needs your eye in the PR | [HS](./HS-harness-shared.md) |
| HS-5 | `stream.start.kind` admits every message type; two are written, and the fold branches for the rest | harness | harness | union cases nothing produces; special and general mixed | ~25 lines, 6 files | assigned; needs your eye in the PR | [HS](./HS-harness-shared.md) |
| HS-6 | The trace read's result is a TS type, so the app writes its document and statuses as schemas twice | harness, texra | harness | repetition; information leakage | ~25 lines, 4 files | assigned | [HS](./HS-harness-shared.md) |
| HS-7 | `isSettledRow` states "settled on arrival" twice, in a set and in its switch | harness | harness | repetition; non-obvious code; single-caller extraction; false comment | ~25 lines, 1 file | assigned | [HS](./HS-harness-shared.md) |
| HS-8 | Comments describe fields and steps the code does not have | harness | harness | false comment | ~15 lines, 5 files | assigned | [HS](./HS-harness-shared.md) |
| HT-1 | `skills list --source` reaches discovery twice: process options and a per-call override | harness, cli | harness | option for a special case; repetition; pass-through variable | ~25 lines, 2 files | assigned | [HT](./HT-harness-tools.md) |
| HT-2 | `SkillSourceContribution.id` is a key nothing reads | harness | harness | export with no consumer; false comment | ~25 lines, 1 file | assigned | [HT](./HT-harness-tools.md) |
| HT-3 | Skill duplicate-name and duplicate-path rule applied per root and again across roots | harness | harness | repetition; special and general mixed | ~30 lines, 1 file | assigned | [HT](./HT-harness-tools.md) |
| HT-4 | Seven of ten `SkillIssueCode` literals are never branched on; one exists through a relabel | harness, cli | harness | error kind nothing branches on; non-obvious code; overexposure | ~70 lines, 5 files | assigned; needs your eye in the PR | [HT](./HT-harness-tools.md) |
| HT-5 | The tool switch record has two readers with two error types | harness | harness | repetition; misplaced owner | ~40 lines, 7 files | assigned | [HT](./HT-harness-tools.md) |
| HT-6 | Executions tool passes a context bag seven handlers never read; two helpers take a caller never absent | harness | harness | pass-through variable; impossible branch | ~60 lines, 4 files | assigned | [HT](./HT-harness-tools.md) |
| HT-7 | Skill sources are a contribution registry with one producer, re-sorted into a fixed tier order | harness | harness | speculative generality; special and general mixed; repetition | ~120 lines, 5 files | assigned | [HT](./HT-harness-tools.md) |
| HT-8 | "Is this plugin switched on": the switch-only rule in one reader, raw membership in three | harness, texra | harness | repetition; information leakage | ~40 lines, 7 files | assigned | [HT](./HT-harness-tools.md) |
| HT-9 | Every diff returns a timeout warning its caller must log; two log it by hand | harness, texra, desktop | harness | conjoined methods; repetition; silent degradation | ~60 lines, 8 files | assigned; needs your eye in the PR | [HT](./HT-harness-tools.md) |
| HT-10 | `fsPath` encodes the filesystem choice in a path's spelling; the edit flow decodes it three times | harness, texra | harness | information leakage; repetition; pass-through | ~50 lines, 8 files | held for your call: whether an approved edit keeps its confined `WorkspaceFs` write or writes through the process filesystem as the read does | [HT](./HT-harness-tools.md) |
| HT-11 | Batched: values a caller already holds, passed or checked again (6 items) | harness, texra, cli | harness | repetition; option for a special case; impossible branch; self-validation | ~70 lines, 10 files | assigned; needs your eye in the PR | [HT](./HT-harness-tools.md) |
| LS-1a | Harness exports that nothing imports, in production or tests | harness | harness | overexposure; export with no consumer | 6 lines, 5 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| TT-1 | An agent-CLI launch is three shared steps each provider calls in order, with the claim, name and strings threaded between | texra | texra | temporal decomposition, pass-through variable, option for a special case, repetition | ~250 lines, 3 files | assigned; needs your eye in the PR | [TT](./TT-texra-tools.md) |
| TT-2 | Which credential Claude Code uses is decided at launch and again, differently, by the availability check | texra | texra | repetition, false status line | ~90 lines, 2 files | assigned; needs your eye in the PR | [TT](./TT-texra-tools.md) |
| TT-3 | "Keep a found answer, retry a miss, one probe at a time" hand-written twice in `agentCli/` (H10 remainder) | texra | texra | hand-written Effect primitive, shared mutable state, repetition | ~120 lines, 3–4 files | assigned | [TT](./TT-texra-tools.md) |
| TT-4 | Setup tools state allowlists twice and re-check what the offer decided | texra | texra | repetition, special and general mixed, comment restating code | ~80 lines, 5 files | assigned; needs your eye in the PR | [TT](./TT-texra-tools.md) |
| TT-5 | Install and sign-in facts of a probed plugin written up to five times, disagreeing on Windows; tool descriptions state unreachable requirements | texra | texra | repetition, false message, special and general mixed | ~60 lines, 9 files | assigned; needs your eye in the PR | [TT](./TT-texra-tools.md) |
| TT-6 | A polled GitHub list's request, cursor, ETag and seen ids held in two places and assembled at six sites | texra | texra | repetition, information leakage | ~130 lines, 6 files | assigned | [TT](./TT-texra-tools.md) |
| TT-7 | Agent-CLI model and effort resolved per provider over two exported halves; note logged in two places | texra | texra | repetition, shallow module, single-caller extraction, temporal decomposition | ~70 lines, 4 files | assigned | [TT](./TT-texra-tools.md) |
| TT-8 | Batched: arXiv download into an empty root, `autoIndent` beside `formatter`, a test-only `editors` fallback, a duplicated `display`, a one-provider option, one more hand-typed list | texra | texra | silent degradation, option for a special case, code for tests, repetition, unreachable branch | ~60 lines, 12 files | assigned; needs your eye in the PR | [TT](./TT-texra-tools.md) |
| TC2-1 | The resources directory and the LaTeX preamble are threaded through each host's window | texra, extension, desktop | texra | pass-through variable; repetition; information leakage | ~60 lines, 9 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-2 | `CommandDirs` is a service and also a module function ten sites call over a module cache | texra, extension, desktop | texra | repetition; shared mutable state; hand-written version of Effect | ~80 lines, 9 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-3 | Per-run guards and wordings written in both `hostRunActions` and `openGuiWindow`; file actions handed copies | texra | texra | repetition; conjoined methods; pass-through method; information leakage | ~120 lines, 3 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-4 | Hosts re-tag a failed capability by hand instead of `hostFailure` | extension, desktop | texra | repetition | ~25 lines, 2 files | assigned (open #14953 fixes it; outside this campaign) | [TC2](./TC2-texra-controllers.md) |
| TC2-5 | Two formatters for "first issue of a failed decode" in the launch path | texra | texra | repetition; hand-written version | ~20 lines, 2 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-6 | `housekeeping/` exports an error only the extension raises, with false comments | texra, extension | texra | false comment; overexposure | ~30 lines, 4 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-7 | The launcher's file catalogs are a host port both hosts fill identically; `commit` placeholder ×3 | texra, extension, desktop | texra | option for a special case; pass-through; repetition | ~30 lines, 5 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-8 | Team planner "ports" are a constant and a service everywhere, bundled by hand at seven sites | texra, cli | texra | option for a special case; pass-through variable; repetition | ~70 lines, 9 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-9 | `RunActive` reworded three ways because the host refusal set omits it | texra, cli | texra | repetition; special and general mixed; information leakage | ~35 lines, 5 files | assigned; needs your eye in the PR | [TC2](./TC2-texra-controllers.md) |
| TC2-10 | Three settings-view messages looser than their actions; controllers re-check at run time | texra | texra | errors not defined out of existence; information leakage | ~50 lines, 6 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-11 | A service call with no answer is worded per channel by four classifiers | texra | texra | repetition; special and general mixed; non-obvious code | ~40 lines, 1 file | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-12 | The open-workspace guard's app side outlives its only setter (remainder of EX-2) | texra, cli | texra | option for a special case; rule decided per host | ~25 lines, 5 files | assigned | [TC2](./TC2-texra-controllers.md) |
| TC2-13 | Batched: dead `disposable.ts`, unused `followed` export, telemetry notice check-then-write, single-caller helper | texra | texra | export with no consumer; false comment; hand-written version; single-caller extraction | ~20 lines, 4 files | assigned | [TC2](./TC2-texra-controllers.md) |
| LS-1b | App exports that nothing imports (one dead type, ten file-local symbols) | texra | texra | overexposure; export with no consumer | 12 lines, 6 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| LS-3 | Four formatter files of one function or one type, each with one consumer | texra | texra | shallow module; single-caller extraction | ~80 lines, 9 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| LS-4a | `ServiceControl` carries one record from the line that builds it to the one layer that reads it | texra | texra | shallow module; pass-through; one-implementation interface | ~15 lines, 2 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| LM-1 | The ChatGPT plan named twice on one bind (`route.plan` and `credential.kind`); WebSocket rule split over both | llm, harness | llm | repetition, option for a special case, false comment, special-general mixed | ~90 lines, 7 files | assigned; needs your eye in the PR | [LM](./LM-llm.md) |
| LM-2 | `allowedReasoningEfforts` is one value in all three producers; Google `'high'` fallback (remainder of O2) | llm | llm | constant column, repetition | ~35 lines, 5 files | assigned | [LM](./LM-llm.md) |
| LM-3 | Upload cache and message threads decided in protocol modules, not the configuration rows (remainder of O6) | llm | llm | information leakage, repetition, false comment | ~25 lines, 5 files | assigned | [LM](./LM-llm.md) |
| LM-4 | `configurationFor` and the Google constructor throw; `constructed` adapter; empty-key check in three places | llm | llm | single-purpose adapter, repetition, non-obvious code | ~40 lines, 4 files | assigned | [LM](./LM-llm.md) |
| LM-5 | Batched: `ConfigurationOf` twice and three aliases, Stainless failure reader twice, `PROTOCOL_OF`, stale comment | llm | llm | repetition, false comment, pass-through variable | ~60 lines, 9 files | assigned | [LM](./LM-llm.md) |
| CC-1 | Layout `mode` means both "print everything" and "price the scrollback"; ring prices unpainted rows (K11 remainder) | cli | cli | option for a special case, special-general mixed, false comment, non-obvious | ~60 lines, 3 files | assigned | [CC](./CC-cli-chat.md) |
| CC-2 | A user row is an inquiry continuation because its text matches a regex, tested in four places | cli + texra/harness | cli | renderer repairing data model, information leakage, repetition | ~40 lines, 5 files | assigned; needs your eye in the PR | [CC](./CC-cli-chat.md) |
| CC-3 | The terminal re-decides tool-card content by knowing how the shared row model built it | cli + harness | cli | information leakage, repetition, special-general mixed | ~90 lines, 3 files | assigned; needs your eye in the PR | [CC](./CC-cli-chat.md) |
| CC-4 | Corner gutter written into strings by three functions and parsed back by a fourth | cli | cli | conjoined methods, repetition, non-obvious | ~50 lines, 3 files | assigned | [CC](./CC-cli-chat.md) |
| CC-5 | Width and rows optional through the transcript path with four defaults no production caller reaches | cli | cli | option for a special case, pass-through variable, overexposure | ~70 lines, 8 files | assigned | [CC](./CC-cli-chat.md) |
| CC-6 | Terminal title re-derives the harness's `sessionActivity` | cli + harness | cli | repetition | ~25 lines, 2 files | assigned; needs your eye in the PR | [CC](./CC-cli-chat.md) |
| CC-7 | Status facts `@ui/copy` owns formatted again in the bar and `/status` (task root, quota percent, request-kind tables) | cli + texra | cli | repetition, information leakage, pass-through | ~60 lines, 6 files | assigned; needs your eye in the PR | [CC](./CC-cli-chat.md) |
| CR-1 | Commands re-read their own flags from raw argv with a hand-written scanner | cli | cli | hand-written version of a library; repetition; non-obvious code | ~150 lines, 8 files | assigned; needs your eye in the PR | [CR](./CR-cli-runtime.md) |
| CR-2 | Which commands are interactive is a name list consulted in three files | cli | cli | special and general mixed; information leakage; option for a special case | ~60 lines, 5 files | assigned; needs your eye in the PR | [CR](./CR-cli-runtime.md) |
| CR-3 | K11 remainder: NDJSON `ts`/`contract` stamp has five writers; kind registry is 33 copies of one struct | cli | cli | repetition; non-obvious code | ~180 lines, 6 files | assigned; needs your eye in the PR | [CR](./CR-cli-runtime.md) |
| CR-4 | The headless run context is a rewritten `CliContext`; `quietLogs` means two things | cli | cli | temporal decomposition; non-obvious code; derivable state; vague name | ~80 lines, 9 files | assigned | [CR](./CR-cli-runtime.md) |
| CR-5 | `CliContext.approvalPrompt` has no writer | cli | cli | export with no consumer; option for a special case | ~20 lines, 2 files | assigned | [CR](./CR-cli-runtime.md) |
| CR-6 | The run-model candidate order is written twice | cli | cli | repetition | ~30 lines, 3 files | assigned | [CR](./CR-cli-runtime.md) |
| CR-7 | Batched: options whose value the callee already holds | cli | cli | option for a special case; pass-through variable | ~50 lines, 8 files | assigned | [CR](./CR-cli-runtime.md) |
| CR-8 | "Can this process run an Ink UI?" restated with drift in `init`, `config edit`, `config`'s route, the update check | cli | cli | repetition; special and general mixed; non-obvious code | ~35 lines, 4 files | assigned; needs your eye in the PR | [CR](./CR-cli-runtime.md) |
| CR-9 | Exit codes decided per command: `report` sends a program's `CliUsageError` to `catchExitCode`; three helpers catch interrupts as failures | cli | cli | repetition; false comment; silent degradation; special and general mixed | ~100 lines, 6 files | assigned; needs your eye in the PR | [CR](./CR-cli-runtime.md) |
| CR-10 | Batched: launch-approval notice ×3, section keys, prompt streams, K4 latch, `envVar`, doctor redaction, `--export` enum, `checkpointPresent`, output-destination readers, optional host members | cli | cli | repetition; option for a special case; shared mutable state; hand-written version; renderer repair; false comment | ~120 lines, 15 files | assigned; needs your eye in the PR | [CR](./CR-cli-runtime.md) |
| LS-1c | CLI and llm exports that nothing imports | cli, llm | cli | overexposure; export with no consumer | 6 lines, 5 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| LS-5 | The headless presentation host: one-implementation interfaces, optional members always set, chat holds all for `emit` | cli | cli | one-implementation interface; overexposure; non-obvious code | ~35 lines, 5 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| DK-1 | Electron's message box lifted into Effect by hand at nine sites in five files | desktop | desktop | repetition, hand-written version, false comment | ~120 lines, 6 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| DK-2 | The sign-in presenter crosses a three-member port that restates the app's two-member one | desktop | desktop | shallow module, pass-through, information leakage | ~70 lines, 3 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| DK-3 | `createDesktopWorkspaceIpc` joins the file handler to a switch that only forwards | desktop | desktop | conjoined methods, pass-through, special-general mixed, vague name, option | ~150 lines, 4 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| DK-4 | "The user is looking at this project" computed three times over two hand-written focus streams | desktop | desktop | repetition, shared mutable state | ~80 lines, 4 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| DK-5 | Structural interfaces written for tests that do not exist | desktop | desktop | shallow module, overexposure, vague name | ~40 lines, 4 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| DK-6 | The window host exposes one capability under several names; callers rebuild what it has | desktop | desktop | overexposure, pass-through, repetition | ~110 lines, 7 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| DK-7 | Platform start-up split into two phases, the second returning what the first computed | desktop | desktop | temporal decomposition, pass-through variable, ticket-citing comments | ~90 lines, 3 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| DK-8 | The recent list has two owners; "every project" rebuilt at each reader (N7 remainder) | desktop | desktop | repetition, special-general mixed | ~90 lines, 6 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
| LS-2 | Two desktop services exist to carry two arguments across one call | desktop | desktop | shallow module; pass-through; one-implementation interface | ~25 lines, 3 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| LS-4b | `DesktopProjectRecords` is provided twice, each time to the one call on the next line | desktop | desktop | shallow module; pass-through | ~15 lines, 3 files | assigned | [LS](./LS-lens-shallow-passthrough.md) |
| EX-1 | Sessions closed three times at deactivation; the ordering comment is false | extension | extension | repetition; false comment | ~12 lines, 1 file | assigned | [EX](./EX-extension.md) |
| EX-2 | "Is there a folder?" asked at seven sites with six answers after activation settled it | extension | extension | errors not defined out of existence; silent degradation; special and general mixed | ~60 lines, 9 files | assigned; needs your eye in the PR | [EX](./EX-extension.md) |
| EX-3 | `texra.showProgressView` decodes an `inPlace` option no caller passes | extension | extension | option for a special case; overexposure | ~14 lines, 2 files | assigned | [EX](./EX-extension.md) |
| EX-4 | `globalState` travels beside the `roots` that hold it | extension | extension | pass-through variable | ~20 lines, 3 files | assigned | [EX](./EX-extension.md) |
| EX-5 | Placement verbs written three times; five reach the host table through a `Deferred` | extension | extension | pass-through method; temporal decomposition; repetition | ~60 lines, 2 files | assigned | [EX](./EX-extension.md) |
| EX-6 | `initVscodePlatform` takes the service as an option its other argument decides | extension | extension | option for a special case; non-obvious code | ~18 lines, 1 file | assigned | [EX](./EX-extension.md) |
| EX-7 | Two error classes carry a `member` literal nothing reads | extension | extension | error kind nothing branches on; overexposure | ~12 lines, 2 files | assigned | [EX](./EX-extension.md) |
| EX-8 | Three file pickers are a factory, an options interface and a thunk | extension | extension | single-caller extraction; shallow module; derivable column | ~70 removed / ~30 added, 3 files | assigned | [EX](./EX-extension.md) |
| EX-9 | `registerCommands` also builds the settings view and returns it | extension | extension | conjoined methods; vague name | ~25 lines, 2 files | assigned | [EX](./EX-extension.md) |
| EX-10 | Instruction notice: a second message-box lift, a wait option missing where a Lean call blocks, a per-host `showSuppress` default | extension, harness, cli | extension | option for a special case; repetition; non-obvious code | ~60 lines, 6 files | assigned; needs your eye in the PR | [EX](./EX-extension.md) |
| EX-11 | Inline comments and inline criticism keep their VS Code handle in module slots | extension | extension | shared mutable state; temporal decomposition | ~50 lines, 4 files | assigned | [EX](./EX-extension.md) |
| EX-12 | Four VS Code calls lifted again in five places beside their owning wrappers | extension | extension | repetition; false comment; export with one consumer | ~80 removed / ~20 added, 8 files | assigned | [EX](./EX-extension.md) |
| EX-13 | Guide page per notice button decided per host; the agent-issue page has one value | extension, desktop, texra, harness | extension | repetition; option for a special case | ~30 lines, 5 files | assigned; needs your eye in the PR | [EX](./EX-extension.md) |
| EX-14 | Batched: guard status union, walkthrough boolean, `viewName`, dead branches, `withProgress` (N2 remainder) | extension, texra, desktop | extension | option for a special case; conjoined methods; false comment; silent degradation | ~70 lines, 9 files | assigned; needs your eye in the PR | [EX](./EX-extension.md) |
| TV-1 | The scrubber's position is set in one module and takes effect only when a second call follows | trace-viewer | trace-viewer | conjoined methods, shared mutable state, option for a special case | ~25 lines, 3 files | assigned | [DK](./DK-desktop-trace-viewer.md) |
