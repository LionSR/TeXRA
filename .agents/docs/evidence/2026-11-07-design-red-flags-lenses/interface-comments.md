# Lens: interface comments (ch. 12, 13)

**Commit read:** main `03c2f51d5d480ca199b7192c687595d20aced5d7`.
**Scope:** `packages/*/src`, plus the two in-tree guidance files that
cite code (`AGENTS.md`, `packages/harness/src/agent/runtime/README.md`).
**Method:** two mechanical sweeps, then reading. The first sweep matched
every backticked identifier in a comment against the identifiers in the
code, tests, scripts and the `.d.ts` files of `effect`, `@types/node` and
the SDKs. It gave 107 raw hits, about 20 of them real. The second resolved
every repo path and `@alias/` module path cited in a comment: 57 raw hits,
4 of them real. Then a grep for claims of the form "the one writer", "the
only caller" or "pinned in", the 15 files with the highest comment share,
the 70 longest doc blocks, and the shipped API reference
(`packages/harness/docs/api/*.md`). Every false comment below was checked
against the code it describes.

Findings already in rounds 1 to 3 are cited, not repeated: B5
(`SessionHandle.ts:114`, now gone), C7 (`sessionViewUpdate.ts:866-870`),
D (`invocation.ts:4-6`, the file is gone), M (`sessionTools.ts:10`),
J5 (`ipc.ts:95`), N8 (`editorPane.ts:421-435`), Q8 (`effect/errors.ts:2-4`),
U4 (`toolPlugin.ts:8-14`), T8 (`executeCommand.ts:41-43`), T
(`sync-package-contributes.mjs:118`, `CommandCatalog.vitest.ts:15-17`),
S (`harness.ts:3`, `ci.yml:101-106`), P2/P6 (`settings.ts:211-223`,
`addTurnUsage`), V R19 (`openGuiWindow.ts:308-313`), Q (`OpenOptions.host`).

## Numbers

**Comment share** (`grep -cE '^\s*(/\*|\*|//)'` over total lines):

| Package              | Comment lines / total | Share     |
| -------------------- | --------------------- | --------- |
| `harness`            | 19,454 / 80,391       | 24.2%     |
| `llm`                | 2,185 / 12,029        | 18.2%     |
| `texra`              | 14,977 / 82,852       | 18.1%     |
| `desktop`            | 2,172 / 14,661        | 14.8%     |
| `cli`                | 6,646 / 45,328        | 14.7%     |
| `extension`          | 2,108 / 16,748        | 12.6%     |
| all `packages/*/src` | 47,649 / 252,427      | **18.9%** |

Within the harness: `platform/` 37.2%, `utils/` 36.4%, `logger/` 35.3%,
`effect/` 32.8%, `shared/` 29.1%, `agent/` 21.9%, `tools/` 20.4%,
`controllers/` 17.2%.

**The 15 files of 200 lines or more with the highest share.** "Prior" names the
round that already reported the share. "Here" is what reading the file
found.

| #   | File                                             | Share (c/t)   | Prior   | Here                                                                                                     |
| --- | ------------------------------------------------ | ------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `harness/src/shared/schemas/rowVersions.ts`      | 73% (240/329) | —       | A version log per row kind, true where spot-checked; left alone (see "Already settled")                  |
| 2   | `harness/src/agent/core/tools/ToolTypes.ts`      | 64% (144/226) | E 63%   | The tool contract; its error contract is false (finding 2); `describe` names its one implementer (6)     |
| 3   | `harness/src/platform/appSignals.ts`             | 62% (176/286) | M 60%   | The consumer registry M named is now false in four places (finding 4)                                    |
| 4   | `harness/src/effect/sessions.ts`                 | 55% (165/301) | B 54%   | The SDK surface. Accurate where checked, except Q's `OpenOptions.host`; a good interface file            |
| 5   | `texra/src/hosts/uiHosts.ts`                     | 52% (139/266) | G 52%   | Not re-read (G, V R14)                                                                                   |
| 6   | `cli/src/runtime/cliProcessRuntime.ts`           | 50% (114/226) | K 50%   | Cites a "rulings ledger, #12720" (finding 7)                                                             |
| 7   | `cli/src/commands/_helpers/defineCliCommand.ts`  | 48% (100/209) | K 47%   | Cites a check that does not exist, `:121` (finding 1)                                                    |
| 8   | `harness/src/utils/files/externalRoots.ts`       | 46% (111/243) | M 45%   | Not re-read (M: "a security policy in prose")                                                            |
| 9   | `texra/src/tools/github/checkRunsClient.ts`      | 44% (153/351) | H 45%   | Explains the same pagination algorithm three times (`:41-45`, `:73-124`, `:194`); see H                  |
| 10  | `harness/src/shared/session/runHistory.ts`       | 43% (159/370) | B/C 43% | `RunCell`'s "only writer" is false (finding 3)                                                           |
| 11  | `texra/src/tools/support/externalBinaryUtils.ts` | 41% (140/344) | H 40%   | "Per-session cache" for a cache that lives as long as the process (`:12`, `:238`; the next line says so) |
| 12  | `harness/src/shared/config/settings.ts`          | 41% (164/404) | P       | P2's false comment (`:211-223`)                                                                          |
| 13  | `harness/src/tools/toolTable.ts`                 | 40% (101/251) | M 40%   | A contract file. Its refusal list (`:194-201`) is the correct copy that `processLayer` gets wrong (5)    |
| 14  | `cli/src/runtime/initPlatform.ts`                | 40% (166/414) | K 39%   | Not re-read (K finding 4)                                                                                |
| 15  | `harness/src/shared/session/sessionView.ts`      | 40% (170/427) | F 41%   | Cites a suite that does not exist, `:11` (finding 1)                                                     |

**Counts:**

- **Names in comments.** 9,426 backticked identifiers; 660 `{@link}`
  references; about 20 names no code defines (finding 5).
- **Comments that repeat the code: few.** 18 of the 4,254 one-line doc
  comments restate the name they document (0.4%, e.g. `LatexDiffsSection.ts:160`
  "Base file options"). 73 `//` lines restate the line after them, nearly all
  the import-group headers the root `AGENTS.md` asks for.
- **Deep modules without an interface comment: few.** In `effect/` and
  `agent/runtime/`, 15 of 322 exports have none. The notable ones are the
  `ModelInvoker` class with its `invoke` member (`ModelInvoker.ts:178-184`),
  `AgentRun` (`run/AgentRun.ts:180`), `runToolUse` (`loop/toolUse.ts:260`) and
  `FollowUps` (`FollowUps.ts:79`). Each has one internal consumer, and its
  contract sits in a module header that lists the steps in order instead
  (finding 6).
- **Long interface comments.** Doc blocks of 20 lines or more: 70. The
  longest on an export are `fetchAllCheckRuns` (52 lines), `AppSignalPayloads`
  (39), `attachCliSessionProgressProjection` (37), `withPerKeyLane` (30),
  `JsonStore` (28) and `RunHistoryRefused` (27).
- **Leakage through comments.**
  - 141 comment lines in the harness name a host (CLI, VS Code, desktop,
    TUI); 19 of them are in `appSignals.ts`.
  - The shipped API reference names internal source files on 11 lines
    (`host.md:419,499,1144,2791`, `index.md:351,373`,
    `plugins.md:107,537,1355,1891,1971`), and `host.md:499` names an app
    file, `sharedSettingsCommands.ts`.
- **Document citations.** 15 lines cite a design note by file name, and 10 of
  those name a note that is not in the repo. 3 cite a PRD section number,
  1 a design's `§7`, 6 a finding id (G4, R1 three times, R9, LAY-1), and 7 a
  ruling or a decision number instead of a reason. 40 comment lines carry an
  issue or PR number; most give the reason as well (finding 7).

### Every false comment found

Thirty-two in source and two in in-tree guidance, none in an earlier
report. "Since" names the change that made the comment false, where the
history shows it.

| #   | Where                                                                      | The comment says                                                                                                                      | What is true                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `harness/src/effect/requestAnswerer.ts:4-6`                                | a request is never left waiting on a handler that "went quiet: that is a denial"                                                      | No deadline: #14772 deleted `APPROVAL_HANDLER_TIMEOUT`. `decisionOf` "waits as long as the handler does" (`:49-53`), and `sessions.ts:69` says so too                                                                                                                                                   |
| 2   | `harness/src/effect/processLayer.ts:167-171` (shipped `host.md`)           | the list of refusals `toolTable` makes, including "a second plugin continuing waiting runs or recording one request kind's decisions" | `toolTable` refuses neither. It does refuse three the list omits: a missing `requires`, a doubly-owned agent-file block, and a duplicate script module (`toolTable.ts:226-244`)                                                                                                                         |
| 3   | `harness/src/effect/processLayer.ts:175-177` (shipped `host.md:1769-1771`) | the root run's title is "an extra model request per root run, outside the run's usage"                                                | It counts: `runRecords.ts:220-223` adds `label.usage` to the run's totals; `runRowsShape.ts:100-101` and `sessionEvent.ts:269-273` call it "part of the run's spend"                                                                                                                                    |
| 4   | `harness/src/agent/core/tools/ToolTypes.ts:67-73` (shipped `index.md`)     | expected tool failures "are returned as literal `{ status: 'error' }`"; unexpected ones "should throw"                                | `defineTool`'s contract is "fail with an `Error`" (`definition.ts:59-61`); 151 of 157 `new ToolError(` sites are Effect failures                                                                                                                                                                        |
| 5   | `harness/src/tools/core/result.ts:26-31`                                   | "the dominant `throw new ToolError(...)` convention … Prefer `throw new ToolError`"                                                   | 6 throws (4 files) against 151 Effect failures; a throw is a defect, which `defineTool` logs as a crash unless it is a `ToolError` (`definition.ts:133-140`)                                                                                                                                            |
| 6   | `harness/src/shared/session/runHistory.ts:176-188`                         | `RunCell` is "the only writer of the rows its state is rebuilt from … One exception" (`endIn`)                                        | `decideRequest` (`requests.ts:305`) and the bypass approvals (`runApprovalQueue.ts:236,259`) append `request.decided` rows, which the run state applies (`runState.ts:340`), outside the cell; the cell's own `refresh` (`:227-236`) takes "every row another writer committed"                         |
| 7   | `harness/src/shared/session/runHistory.ts:2-4`                             | the run history is "the only writer of the rows a run's state is rebuilt from"                                                        | As #6. The same file's `runStateAppend` doc (`:136-137`) says it is "used by the run's cell and the session's requests"                                                                                                                                                                                 |
| 8   | `harness/src/agent/runtime/requests.ts:287`                                | `decideRequest` is "the one writer of a decision"                                                                                     | Five places build `request.decided` rows: `requests.ts:194-205`, `:305`, `ModelInvoker.ts:667` (`PERSONAL_RETRY`), `runApprovalQueue.ts:148-160`, and `runState.ts:245-258` (`cancelRequestRows`, used at `RunHistory.ts:340` and `runLifecycle.ts:189`). B5's false claim moved here with the function |
| 9   | `harness/src/agent/runtime/executeAgent.ts:359-361`                        | open requests "close with the fibers waiting on them (`SessionRequests.ask`)"                                                         | `SessionRequestsShape` has no `ask`. The end's transaction cancels open requests (`cancelRequestRows`; `requests.ts:368-374`)                                                                                                                                                                           |
| 10  | `harness/src/platform/appSignals.ts:55-56`                                 | desktop answers `githubTokenInvalid` with an "error dialog + re-post of the Git tab's token status"                                   | A dialog only (`desktopSettingsIpc.ts:200-212`). Its own comment (`:194-198`) says a re-post would repaint the same badge                                                                                                                                                                               |
| 11  | `harness/src/platform/appSignals.ts:117-120`                               | `workspaceAgentsChanged` is emitted by "the tool registry (`pluginCatalogLayer`)"                                                     | `pluginCatalog.ts` emits nothing. The emitters are `agentCatalogFollower.ts:93-96,233-237` and, through `reloadAgentCatalog`, `fileEditFlow.ts:245`                                                                                                                                                     |
| 12  | `harness/src/platform/appSignals.ts:121-122`                               | "Settings-originated changes … do not emit"                                                                                           | The settings view's team change (`settingsAgentCommands.ts:440` → `WorkspaceAgentsController.ts:386`) writes `ACTIVE_TEAM_ID`, whose change feed emits (`agentCatalogFollower.ts:225-237`, which names "the settings view")                                                                             |
| 13  | `harness/src/platform/appSignals.ts:124-126`                               | consumers of `workspaceAgentsChanged`: "extension and desktop settings views"                                                         | Also the extension's launcher (`ProgressViewProvider.ts:395-405`). The header (`:44-48`) asks that the note be "kept truthful"                                                                                                                                                                          |
| 14  | `cli/src/commands/doctor.ts:104-105`                                       | "the CLI's one pinned no-runtime run … (`BARE_EFFECT_RUN_SITES` in dependencyDirection.vitest.ts)"                                    | Neither the suite nor the list exists. oxlint allows `Effect.run*` anywhere in `packages/cli/src` (root `AGENTS.md`), which holds 5 such calls                                                                                                                                                          |
| 15  | `cli/src/commands/_helpers/context.ts:17-18`                               | "pinned in `BARE_EFFECT_RUN_SITES`"                                                                                                   | As #14                                                                                                                                                                                                                                                                                                  |
| 16  | `cli/src/commands/_helpers/defineCliCommand.ts:121`                        | "The CLI's one pre-runtime run (pinned in `BARE_EFFECT_RUN_SITES`)"                                                                   | As #14. `doctor.ts:104` also calls itself "the CLI's one"                                                                                                                                                                                                                                               |
| 17  | `harness/src/shared/schemas/sessionEvent.ts:17-19`                         | "`dependencyDirection.vitest.ts` keeps the shared-to-agent allowlist empty"                                                           | No such suite, and no oxlint pattern bans `@agent/*` in `shared/` (the harness override bans hosts and the app only). The allowlist is empty today (0 imports) by convention                                                                                                                            |
| 18  | `harness/src/shared/session/sessionView.ts:11`                             | "`sessionPresentationBoundary.vitest.ts` pins the interaction-state names"                                                            | No such suite; no test names those states                                                                                                                                                                                                                                                               |
| 19  | `harness/src/agent/runtime/runRegistry.ts:602-603`                         | `registryOf` is for "the files `runRegistryAccessRatchet` names"                                                                      | No such check. 9 files call the cast (`Runs` → `RunRegistry`)                                                                                                                                                                                                                                           |
| 20  | `texra/src/shared/constants/latexToolchain.ts:204-206`                     | a `tools`/`latex` home "would create the cross-subsystem cycle the LAY-1 edge ratchet forbids"                                        | No such check; no oxlint override covers `packages/texra/src/{tools,latex}` edges                                                                                                                                                                                                                       |
| 21  | `texra/src/shared/commands/catalog.ts:356-358`                             | "`CommandCatalog.vitest.ts` diff-checks it"                                                                                           | That suite has one test, on keybinding order (`packages/texra/test/commands/CommandCatalog.vitest.ts:22`), and never reads `package.json`; `sync-package-contributes.mjs --check` is the diff. T found the suite's own copy of the claim                                                                |
| 22  | `harness/src/shared/session/agentEvent.ts:38-40`                           | `run.end` "is written once by the storage finalizer (`finalizeRun`)"                                                                  | No `finalizeRun`, gone since #14769; the writer is `endRunRows` (`agent/storage/runLifecycle.ts:325`) via `endRun`                                                                                                                                                                                      |
| 23  | `harness/src/agent/runtime/loop/runProgram.ts:143-146`                     | the halt "commits with the run's `run.end` (`finalizeRun`)"                                                                           | As #22                                                                                                                                                                                                                                                                                                  |
| 24  | `harness/src/tools/codemode/backgroundScript.ts:8-9`                       | its result reaches the parent "(`createScriptRunStrategy`)"                                                                           | Deleted in #14769; the report is `childEndReport` (`agent/runtime/scriptRun.ts:6`)                                                                                                                                                                                                                      |
| 25  | `cli/src/runtime/cliContext.ts:246-247`                                    | "`readCliVersion` and `readCliBugsUrl` both derive from it"                                                                           | No `readCliBugsUrl`; the second reader is `formatCrashReportLine` (`:267-268`)                                                                                                                                                                                                                          |
| 26  | `texra/src/shared/launcher/fileTypes.ts:10-13`                             | the "get/set current editor file" round trip "(`GET_CURRENT_FILE` / `SET_CURRENT_FILE`)"                                              | Neither message exists; the round trip is the `useCurrentFile` host request (`shared/session/hostRequest.ts:124-128`)                                                                                                                                                                                   |
| 27  | `harness/src/shared/schemas/sessionEvent.ts:236-237`                       | `AgentEvent` is in "`packages/harness/src/agent/trace/events.ts`"                                                                     | No such file; `AgentEvent` is `shared/session/agentEvent.ts:56`                                                                                                                                                                                                                                         |
| 28  | `texra/src/replacement/advanced.ts:395-396`                                | `parseCriticismAnnotations` is in "`@latex/criticismParser`"                                                                          | It is `packages/extension/src/frontend/latex/criticismParser.ts:58`, which the app cannot import. The claim that both share one scanner holds (`braceBalancedMacro`)                                                                                                                                    |
| 29  | `harness/src/shared/schemas/runHistoryEvent.ts:6-10`                       | spreading "`.shape`" or a "`strictObject`'s shape" drops "its strictness"                                                             | Zod vocabulary. Effect structs are not strict and have `.fields`; the part of the reason that still holds is that spreading `.fields` drops a struct-level `.check`                                                                                                                                     |
| 30  | `texra/src/tools/support/externalBinaryUtils.ts:12`, `:238`                | "the per-session cache wrapper"                                                                                                       | One `SynchronizedRef` per module import (`:255`), kept "for the process lifetime" as the next line (`:239`) says                                                                                                                                                                                        |
| 31  | `harness/src/utils/core/perKeyQueue.ts:46-48` (shipped `host.md`)          | the queue prototype "measured 84 lines against these 65"                                                                              | `withPerKeyLane` is 44 lines (`:57-100`)                                                                                                                                                                                                                                                                |
| 32  | `harness/src/agent/core/tools/ToolTypes.ts:29-31`                          | the loop's guard is the one place approval is asked, "so no tool body opens its own approval prompt"                                  | Contradicted 95 lines below: `requiresApproval: 'inBody'` (`:124-131`), declared by 7 tools (Edit, Write, Plan, agent, user question, external inquiry, accept-run-files)                                                                                                                               |
| —   | `harness/src/agent/runtime/README.md:40`                                   | `agent/storage/runLifecycle`'s `finalizeRun`                                                                                          | As #22                                                                                                                                                                                                                                                                                                  |
| —   | root `AGENTS.md:213-215`                                                   | model calls "retry in the one loop in `runtime/run/invocation.ts`"                                                                    | Deleted in #14778. The harness `AGENTS.md` describes two loops (`ModelInvoker.invoke`, `callModel`). `check-guidance-refs` misses it because the path has no repo prefix                                                                                                                                |

Nineteen of the thirty-two describe something that has left the code while the comment stayed: a removed deadline (#1), a deleted check (#14 to #21), a renamed or deleted symbol or file (#9, #22 to #28), Zod (#29) and an old line count (#31). Fourteen are claims about another module (#2, #3, #6 to #8, #10 to #13, #17, #19 to #21, #32), which is information leakage written as prose.

---

## Finding 1. Eight comments cite checks that do not run

**Red flags:** false comment; a comment standing in for a check. These are
unknown unknowns: a reader trusts a guard that is not there.

**Evidence.** Table rows #14 to #21. The CLI says its one bare
`Effect.run*` is "pinned" in three places (`doctor.ts:104-105`,
`context.ts:17-18`, `defineCliCommand.ts:121`). Two of those places each
call themselves "the one", and `packages/cli/src` has 5 such calls (K
counted them too, as "the pinned edges"). The rule that `shared/` imports
no `@agent/*` module is said to be held by `dependencyDirection.vitest.ts`
(`sessionEvent.ts:17-19`). The root `AGENTS.md` says there are "no
architecture tests", and `.oxlintrc.json`'s harness override has no such
pattern. `registryOf` (`runRegistry.ts:602-606`) is a cast from the public
`RunsShape` to the internal `RunRegistry`. Its safety rests on a ratchet that
is gone, and 9 files call it: `SessionRequests.ts`, `sessionOwners.ts`,
`processRun.ts`, `rootLaunch.ts`, `toolUse.ts`, `runProgram.ts`,
`childLaunch.ts`, `resumeRun.ts` and `sessionPrograms.ts`. The suites were
deleted before this clone's history begins (`e7c3ab4430`, #14679). #14748
deleted the ratchet baselines (S).

**The design decision behind it.** "Who holds this boundary?" The answer
was once a suite. When the suite went, the claim stayed, so the boundary
is now held by prose.

**The better design.** For each claim, either the code holds it or the
comment says nothing about a check.

- The CLI's bare runs: `Effect.run*` is permitted in host packages, so
  delete the "pinned" clauses and the "one" (3 sites).
- `shared/` → `@agent/*`: the harness override in `.oxlintrc.json` already
  bans the hosts and the app for `packages/harness/src/**`. A
  `shared/**`-scoped override adding `@agent/**` would make the claim true;
  it would restate the harness's patterns, as the file's rule for later
  overrides requires. Otherwise delete the clause. The root `AGENTS.md`
  prefers no new lint rule, so deleting it is the default.
- `registryOf`: let the session layer serve the registry under its own
  `Context.Service` tag, with the same value it serves as `Runs`, so the
  9 internal callers `yield*` the type they need and the cast and its
  comment go. Hosts and tools keep `Runs`.
- Delete the `sessionPresentationBoundary`, LAY-1 and `CommandCatalog`
  claims; the last one points at `sync-package-contributes.mjs --check`.

**Deleted:** 8 false clauses; `registryOf` and its cast (1 definition, 9 files
of callers) if the second tag is taken.

**What we give up.** Nothing that exists today. A second tag is one more
name, for internals only.

**Change amplification.** "Rename `RunRegistry`": today 9 casts that no
check covers; with the tag, the compiler covers all of them.

**Depends on:** none.

## Finding 2. The tool error contract is written three ways, and the two in the public plugin API are false

**Red flags:** false comment; two representations of one rule.

**Evidence.**

- `ITool`'s doc (`ToolTypes.ts:67-73`, shipped in
  `packages/harness/docs/api/index.md`, exported at `index.ts:92`) says an
  expected failure is returned "as literal `{ status: 'error', error }`
  ToolResult values" and an unexpected one "should throw".
- `errorResult`'s doc (`tools/core/result.ts:26-31`) calls
  `throw new ToolError(...)` "the dominant convention" and says to prefer it.
- `defineTool`'s `execute` (`definition.ts:59-61`) is the one that is true:
  "fail with an `Error` and the model reads its message as the tool's
  error". `defineTool` treats a throw as a defect and logs it as a crash
  unless it is a `ToolError` (`:133-140`).
- The code follows `defineTool`: 151 of 157 `new ToolError(` sites are Effect
  failures, against 6 throws in 4 files (`pathResolution.ts:136`,
  `inquiryRecords.ts:99,104,111`, `agentCliModel.ts:49,54`). `errorResult` has
  40 call sites in 14 files, and literal `status: 'error'` results appear 10
  times in tool bodies.

**The design decision behind it.** "How does a tool say that its call
failed?" The rule was written down where `ITool` was declared, before
`defineTool` existed, and again where the helper sits. It was re-decided
in Effect terms only at `defineTool`.

**The better design.** One owner: `defineTool`'s doc states the contract. A
tool fails with an `Error`, a `ToolError` when it carries a `summary`, and the
model reads the message. A defect is a bug and is logged. `ITool`'s doc says
only what `call` returns. `errorResult`'s doc says when a value-channel error
is right: a call that returns a partial result per item and keeps going. The
6 throws become `Effect.fail`. Deleted: the two false paragraphs, and the
"prefer `throw`" advice.

**What we give up.** Nothing.

**Change amplification.** "A plugin author writes a tool": today they read
three rules in two published files and one source file. After, they read one.

**Depends on:** none. `result.ts` and `ToolTypes.ts` are in no open PR.

## Finding 3. "The only writer": the run cell's contract is false, because B5's one decision writer landed halfway

**Red flags:** false comment; an interface comment that has to list
exceptions ("hard to describe"); two writers of one fact.

**Evidence.** Table rows #6 to #8.

- `RunCell`'s doc (`runHistory.ts:176-188`) says it is the only writer of
  the rows its state is rebuilt from, "and nothing sets the state it holds
  but what that returns". It names one exception.
- Three writers outside the cell append rows the run state applies
  (`runState.ts:340`): `decideRequest` (`requests.ts:300-306`) and the
  bypass approvals, twice (`runApprovalQueue.ts:230-236`, `:241-259`). All
  go through `runStateAppend`, whose doc in the same file (`:136-137`) says
  it is "used by the run's cell and the session's requests".
- The cell's own `refresh` (`:227-236`) exists to take "every row another
  writer committed".
- `decideRequest` calls itself "the one writer of a decision"
  (`requests.ts:287`). That was B5's design (`decideRequest` as "the checked
  append any surface or policy uses", B5 `:459`; root designs `:447`), and
  B5's false claim on `SessionHandle.ts:114` moved here with the function.
  But four other sites still build `request.decided` rows themselves:
  - the policy's own answer (`requests.ts:194-205`);
  - the invoker's automatic quota retry (`ModelInvoker.ts:114-117,667`);
  - the bypass approvals (`runApprovalQueue.ts:148-160`);
  - `cancelRequestRows` (`runState.ts:245-258`, used by `RunHistory.ts:340`
    and `runLifecycle.ts:189`).

  `decideRequest` has 8 references in 5 files.

**The design decision behind it.** "Who may change a run's state?" The
design said one writer. The code gives one writer per kind of row, and the
cell re-reads the rest. The comment states the plan, not the code.

**The better design.** The two choices:

- **A: finish B5.** The policy answer and `cancelRequestRows` are drafts
  committed beside the batch that opens or ends the request, so they are a
  different kind of writer. The bypass approvals and `PERSONAL_RETRY`
  become `decideRequest` calls. Then `decideRequest` really is the one
  checked decision, and `refresh` is the only way a cell sees it.
- **B (the minimum, and true today): describe the cell as what it is.** "A
  run's state, rebuilt from every row committed to its aggregate; the run's
  own batches commit under the cell's lock (`append`), and `refresh` takes
  the rows other writers committed (a decision, a bypass approval)." The
  same `SynchronizedRef.updateAndGetEffect` already serves both
  (`RunHistory.ts:366-387`). The "only writer" sentences go (`:2-4`,
  `:176-188`, `requests.ts:287`).

Take B now and A with B5's remaining steps. The root `AGENTS.md` rule "no
second writer of the run history" is about the history's rows through the
publisher, which B states truthfully.

**What we give up.** With B, nothing. A changes when the bypass approvals
commit (in `decideRequest`'s transaction rather than in the grant's own), so
the order of their rows needs care: `runApprovalQueue.ts:305` decides them "in
the grant's own transaction".

**Change amplification.** "A new way a request gets answered": today a
fifth row builder that nothing tells the cell about. After A, one
`decideRequest` call.

**Depends on:** B5's remaining design (root design R, `:440-460`) for A;
none for B.

## Finding 4. `AppSignals`' consumer registry is already false in four places

**Red flags:** false comment; information leakage (a general module's doc
listing its users); the hard-to-describe signal (a 39-line header).

**Evidence.** Table rows #10 to #13. M reported the registry as prose, not
as false. Its header (`appSignals.ts:44-48`) says every signal records
"which hosts consume it and — where a host does not — why not … Keep the
note truthful". There are 7 signals, 18 emit sites and 15 subscription
sites, and the four errors are an invented desktop re-post, a wrong
emitter, a wrong "settings do not emit", and a missing consumer. The
module also names a TeXRA app file in the harness's shipped reference
(`:94`, `host.md:499`). It carries history ("the `EventEmitter` this
replaces ran every listener …", `:30-35`) and a note for its own suites
("the reason the suites here yield once before they publish", `:41-42`).

**The design decision behind it.** "Does every host react to every signal?"
That fact belongs to each host. The harness wrote it down for all of them,
so each host change edits the harness's doc, or (as here) does not.

**The better design.** Each payload doc says what changed and who emits it
(a harness fact). Who listens is greppable (`appSignalStream('x'`,
`onAppSignal('x'`, `followSignal('x'`) and is said where each host
subscribes. A host that does not react needs no note; that is the default
of a subscription. The history and test sentences go.

**Deleted:** about 60 lines (the per-signal "Consumed by" paragraphs and the
header's registry rule), and the app file name in the SDK doc.

**What we give up.** A one-file answer to "which hosts react to X". It is
wrong today; `grep` gives the right one.

**Change amplification.** "A host starts listening to a signal": today 2
files (the host and the harness's doc, which drifts). After, 1.

**Depends on:** none.

## Finding 5. `processLayer`'s shipped doc restates two owners' facts and gets both wrong

**Red flags:** false comment; information leakage (one module's rules
copied into another's interface); hard to describe (24 lines over three
owners' decisions).

**Evidence.** Table rows #2 and #3. `processLayer` (`processLayer.ts:155-178`,
shipped in `host.md`) is the entry every host builds its runtime from.

- Its doc copies `toolTable`'s refusals: it invents two that do not exist
  and omits three that do. `toolTable.ts:194-201` is the correct copy.
- It says the title request is "outside the run's usage", while
  `runRecords.ts:220-223` adds it to the totals.
- The `Sessions.layer` doc (`:118-131`) restates the same refusal rule a
  third time, through a link to `processLayer`.

**The design decision behind it.** "What can make the process fail to
build?" `toolTable` owns it. "What does a root run cost?" The
`run.description` row and `RunLabels` own it. `processLayer` restated both.

**The better design.** `processLayer` says what it gives: the process
services and the `Sessions` for a host's `ManagedRuntime`, disposed with
it. It fails with `PluginsRefused` when the plugin list is refused, with a
`{@link toolTable}`. The title sentence moves to `RunLabels` and says what
is true: one helper request per root run, counted in the run's spend. Two
false sentences are deleted from the shipped reference.

**What we give up.** Nothing.

**Change amplification.** "`toolTable` adds a refusal": today 2 docs (one
already wrong). After, 1.

**Depends on:** none (`docgen` regenerates `host.md` in the same PR).

## Finding 6. Interface comments that narrate the implementation

**Red flags:** implementation detail in an interface comment; special and
general mixed (a general member documented by its one implementer); a deep
module whose interface has no comment.

**Evidence.**

- **`ModelInvoker`** (`ModelInvoker.ts:1-19`). The header walks the steps:
  `prepareTurn`, the `attempt` row, `identified`, the stream bridged into the
  trace, `nextAttempt` "reads the next move". `invoke`, the one member a
  caller writes against (`loop/toolUse.ts:392`), has no doc, and its result
  type `InvocationOutcome` is file-local (`:139-143`). A caller needs three
  facts: which outcomes come back (`response`, `failed` with the state's
  `lastError`, `cancelled`), that each one's rows are committed, and which
  errors are storage refusals.
- **`runToolUse`** (`loop/toolUse.ts:260`) has no doc. Its module header
  (`:1-23`) lists the write points in order, a second copy of the harness
  `AGENTS.md` "Write points".
- **`withPerKeyLane`** (`perKeyQueue.ts:27-56`, shipped in `host.md`). 30
  lines: how the `Deferred` chain hands off, then a design rejected in
  review, with a line count that is wrong (row #31). Its caller needs
  three sentences: FIFO per key; interruption hands the turn on; and
  `refuseClaim` refuses on the current occupant. The rejected design is
  already in `refuted-candidates.json` (the `Semaphore` entry).
- **`ITool.describe`** (`ToolTypes.ts:137-152`, shipped `index.md:373`). A
  member of the public tool contract with one implementer
  (`ScriptTool.ts:359`) and 3 readers (`step.ts:146,170`,
  `agentToolResolution.ts:146`). Its doc has to say "The tool that has one is
  the script tool" and explain that tool's freeze in `step.ts`.
- **`fetchAllCheckRuns`** (52 lines) explains the same pagination three
  times in one file (`checkRunsClient.ts:41-45`, `:73-124`, `:194`); H owns
  the structure.
- **The shipped API reference names internal files** on 11 lines (Numbers),
  which a package reader cannot open.

**The design decision behind it.** "Where does the explanation of how it
works go?" The answer was the module header or the export's doc, so the
interface comment became the implementation's narration.

**The better design.** An interface comment says what the caller gets.
The order of steps lives at the code that takes each step (most already
have a line comment there). `describe` leaves `ITool`: the script tool's
description is computed by the step that renders the system text, which
already special-cases it (`step.ts:146`). The `ITool` contract loses a
member that only one tool fills.

**Deleted:** about 50 lines of interface narration across the five; one
`ITool` member (1 implementer, 3 readers).

**What we give up.** A single place to read the loop's step order; the
harness `AGENTS.md` "Write points" already is that place.

**Change amplification.** "Rename a step of the invoker": today the code,
the module header and `AGENTS.md`. After, the code and `AGENTS.md`.

**Depends on:** none.

## Finding 7. Document citations in code

**Red flags:** document citations (root `AGENTS.md`: "No document
citations in code … state the reason"); a citation to a document that
does not exist is also a false comment.

**Evidence.**

- **Notes that are not in the repo** (10 lines, 4 notes). Searching the
  whole repo finds no file by these names:
  - `2026-05-14-10-architecture.md`, 6 lines: `Select.tsx:5`, `glyphs.ts:6`,
    `KeyHints.tsx:3`, `terminalNotifier.ts:2`, `statusBarDisplay.ts:422`,
    `terminalCapabilities.ts:10`;
  - `2026-05-14-30-reference.md (R9)`, 1 line: `terminalNotifier.ts:13`;
  - `2026-06-11-agent-native-onboarding.md`, 2 lines:
    `setupContinuation.ts:1`, `setup.ts:35`;
  - `2026-08-26-effect-4-runtime-migration.md`, 1 line:
    `loopbackLogin.ts:8-9`, "Worked exemplar for the Effect 4 runtime PRD".
- **Section numbers and finding ids.**
  - PRD sections: `subscribeApprovals.ts:1` ("PRD one-fold-three-renderers,
    10.1"), `chatSessionController.ts:180` ("PRD 10.1"), `:330` ("PRD 7.6").
  - A design section: `pruneStorage.ts:2` ("the storage design's §7").
  - Round-2 finding G4: `runProgressRenderer.ts:314` ("G4, one table").
  - Root design R1: `extension.ts:296` ("This host's R1 entry"),
    `desktopWindowLifecycle.ts:81`.
  - LAY-1: `latexToolchain.ts:206`.
- **Rulings instead of reasons.**
  - `desktopPreviewHost.ts:39-41`: "the owner ruling of 2026-09-18 retires
    the former `Promise` face, which the 1.0 clean rule reads as an R1
    adapter rather than the permanent one an earlier ruling allowed".
  - `cliProcessRuntime.ts:22`: "rulings ledger, #12720".
  - `colors.ts:68`: "decided in TeXRA#8118".
  - `loadChatExportInput.ts:18`: "per #7246 Decision 1".
  - `desktopUpdateChecker.ts:12`: "issue #7682, decision: arm b".
  - `desktopDiffMessages.ts:71-72`: "Cursor Bugbot review on PR #3815".
  - `commands.ts:39`: "#3787 follow-up".
- **Plan phases:** `terminalNotifier.ts:4-5` ("Phase 1 ships … lands in
  Phase 4").
- **Issue and PR numbers.** 40 lines carry one. Most also give the
  reason, as a regression pointer (`stateSettings.ts:196`, `#11173`), and
  are left alone.

**The design decision behind it.** "Why is the code this way?" The answer
was a pointer to where it was decided, written while that document was
open.

**The better design.** Replace each pointer with the reason in a sentence.
`desktopPreviewHost.ts:39-41` becomes "Its members are Effects; a host
entry that answers a framework callback runs one." The four missing notes'
lines either state the convention they cite (the TUI's intuitiveness
conventions are the `texra-cli` skill's) or go. **Deleted:** 33 citation
clauses, each replaced by its reason or by nothing.

**What we give up.** Links to the history. `git log -S` and the PR numbers
still find it.

**Depends on:** none.

---

## The "hard to describe" abstractions

These are interfaces whose comments must be long, or must list exceptions,
because the thing does more than one job. For each, the abstraction that
would be short to describe:

| Interface (doc length)                                           | Why it is hard to describe                                                                                                                                                                                   | The abstraction that is short to describe                                                           | Status                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `RunCell` (`runHistory.ts:176-188` + `append` 25 lines)          | "The only writer … one exception", false (finding 3)                                                                                                                                                         | "A run's state, rebuilt from its aggregate's committed rows; its own batches commit under its lock" | Finding 3                                                                                                                                 |
| `RunsShape.stop(runId, reason)` (`runs.ts:40-52`, 12 lines)      | Two operations behind one literal. `user` stops the work, cancels its remote operation and decides its children by a setting; `shutdown` only ends this process's hold and leaves the operation for a resume | `stop(runId)` (the work ends) and `release(runId)` (this process lets go)                           | The stop-paths inventory (`2026-11-03-storage-errors-and-stop-paths.md:217-263`) keeps two reasons. The doc shows they are two operations |
| `AppSignalPayloads` (39-line header, 9-to-14-line entries)       | Records every host's reaction (finding 4)                                                                                                                                                                    | "A process-wide fact changed; re-read it", with its emitter                                         | Finding 4                                                                                                                                 |
| `processLayer` (24 lines)                                        | Restates `toolTable`'s rules, the HTTP dispatcher policy and the run-title billing (finding 5)                                                                                                               | "The process services and sessions of a host's runtime; fails when the plugin list is refused"      | Finding 5                                                                                                                                 |
| `ITool.describe` (16 lines)                                      | A general member with one implementer, documented by that implementer's freeze                                                                                                                               | No member: the step that renders the system text computes the script tool's description             | Finding 6                                                                                                                                 |
| `withPerKeyLane` (30 lines)                                      | Implementation and review history in a public doc                                                                                                                                                            | "Run after every earlier entrant on `key`, FIFO; `refuseClaim` refuses on the occupant"             | Finding 6                                                                                                                                 |
| `fetchAllCheckRuns` (52 lines)                                   | Paginates, dedupes, caches each page's ETag and caps, all in one function                                                                                                                                    | "All check runs of a commit, deduped, with the pages read", per H                                   | H, found                                                                                                                                  |
| `RunHistoryRefused` (27 lines)                                   | A list of raise sites for reasons nothing branches on                                                                                                                                                        | One refusal with a message                                                                          | C7, found                                                                                                                                 |
| `OpenOptions.host?: Record<string, never>` (`sessions.ts:85-93`) | A boolean written as an empty record                                                                                                                                                                         | Answered by `attach`                                                                                | Q, found                                                                                                                                  |

## Good modules in this area

- **`defineTool`** (`tools/core/definition.ts:59-76`). The one true copy of
  the tool error contract: short, and it states the one coupling a caller
  must keep by hand (`value` with `scriptReturns`).
- **`Session` and `Run`** (`effect/sessions.ts:123-246`). Each member says
  what it promises and how it fails, never how it works. They were accurate
  wherever checked.
- **`decisionOf`** (`requestAnswerer.ts:49-53`). Its doc was rewritten with
  #14772's change; the module header above it was not (row #1). A good doc
  next to a stale one in the same file.
- **`toolTable`** (`toolTable.ts:194-201`). The refusal list lives beside the
  checks it describes.
- **The `Plugin` interface's members** (`tools/plugins.ts:103-147`). Each is
  one or two sentences on what the member does.

## Already settled, left alone

- **`rowVersions.ts`' version log (73%).** Each `vN:` line says why an older
  build's row would read wrong. That is the bump rule in the harness
  `AGENTS.md` "Storage format", and the field names checked
  (`takesFollowUps`, `awaited`, `displayText`, `allowBypass`, `lane`, `cut`,
  `reads`, `modules`) exist. The `config/storage/frozen/` it cites (`:20-21`)
  does not exist yet; the suite skips when it is absent
  (`rowVersions.vitest.ts:97`) until the first release writes it.
- **Import-group header comments** (`// Node imports`). They are most of the
  73 code-restating `//` lines, and the root `AGENTS.md` "Code style" asks
  for them.
- **Issue numbers beside a stated reason**: regression pointers, not
  citations.
- **`effect/sessions.ts` at 55%.** An interface file, per B. Q owns its one
  defect.
- **`withPerKeyLane` onto a `Semaphore`** (`refuted-candidates.json`).
  Finding 6 cuts the doc, not the primitive.

## Effect-native mapping

Every API below was checked in `node_modules/effect` 4.1.2 `dist/*.d.ts`.

| Finding                                        | Today                                                                                                 | Effect-native shape                                                                                                                                                                                        | API (4.1.2 `.d.ts`)                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2. Tool failures                               | 6 `throw new ToolError`; two docs telling authors to throw or return literal errors                   | Fail on the error channel with the tagged error; `defineTool` stays the one boundary that turns a failure into the model's error and logs a defect as a bug                                                | `Effect.fail` (`Effect.d.ts:2161`); `Schema.TaggedError` (`Schema.d.ts:11985`); `Effect.catchCause` (`Effect.d.ts:5218`); `Cause.hasDies` (`Cause.d.ts:987`) |
| 1. `registryOf`'s cast held by a deleted check | `runs as RunRegistry` in 9 files                                                                      | A second service tag for the registry, served by the session layer with the same value as `Runs`; internals `yield*` it                                                                                    | `Context.Service` (`Context.d.ts:196`)                                                                                                                       |
| 3. The run cell's state                        | One `SynchronizedRef` serving `append` and `refresh` (`RunHistory.ts:366-387`); docs claim one writer | Unchanged primitive; the doc describes the state as rebuilt from the aggregate's committed rows. Design A routes the bypass approvals and `PERSONAL_RETRY` through `decideRequest`'s `SessionLog.transact` | `SynchronizedRef.updateAndGetEffect` (`SynchronizedRef.d.ts:886`)                                                                                            |
| Row #1. An approval handler that goes quiet    | Header promises a denial; no bound since #14772                                                       | Keep no bound (a person's prompt has its own deadline) and fix the header. If a bound is wanted back, it is one combinator inside `decisionOf`                                                             | `Effect.timeoutOption` (`Effect.d.ts:8377`)                                                                                                                  |
| 4. Who listens to a signal                     | A prose registry in the harness                                                                       | No new structure: each host's subscription already is the fact (`appSignalStream` piped through a filter)                                                                                                  | `Stream.filter` (`Stream.d.ts:5253`); `PubSub.unbounded` (`PubSub.d.ts:444`)                                                                                 |

Findings 5, 6 and 7, and the dangling names in rows #22 to #31, are prose
fixes with no structure behind them. Writing references to code as
`{@link Symbol}` (660 in use already) lets the editor's rename carry them
along; a backticked name is plain text that no tool updates. That is a
TypeScript editor feature, not checked here against a `.d.ts`.
