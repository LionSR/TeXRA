# TC: app controllers and the rest of `packages/texra/src` outside tools, latex, replacement and ui

Read on `main` at `d70ad92` (the brief's commit; `HEAD` `93906b9` adds only
the brief). Scope: `packages/texra/src/controllers/`, `agent/`, `hosts/`,
`platform/`, `model/`, `common/`, `utils/`, `telemetry/`, `housekeeping/`,
`shared/`.

## Numbers

28,877 lines of TypeScript in 237 files.

| Directory       |  Lines | Files |
| --------------- | -----: | ----: |
| `controllers/`  | 12,550 |    56 |
| `shared/`       |  7,560 |    53 |
| `agent/`        |  4,785 |    26 |
| `utils/`        |  1,419 |    15 |
| `telemetry/`    |    677 |     3 |
| `common/`       |    456 |     6 |
| `platform/`     |    441 |     4 |
| `model/`        |    431 |     6 |
| `housekeeping/` |    353 |     3 |
| `hosts/`        |    205 |     2 |

Five largest files:

| File                                          | Lines |
| --------------------------------------------- | ----: |
| `shared/settingsView/settingsViewMessages.ts` |   777 |
| `controllers/session/openGuiWindow.ts`        |   747 |
| `shared/constants/latexToolchain.ts`          |   698 |
| `controllers/server/client.ts`                |   695 |
| `shared/session/surface.ts`                   |   653 |

## TC-1: The same four file verbs arrive as two host requests with two vocabularies, and are dispatched in two places

- flags: information leakage, repetition, vague name, pass-through, temporal decomposition
- package: texra (`shared/session/hostRequest.ts`, `controllers/session/openGuiWindow.ts`, `controllers/progressView/ProgressDocumentTaskFileActionsController.ts`, `latex/latexdiff/latexdiffVerbs.ts`, two `ui/progress` components)
- kind: refactor
- size: M
- earlier: none (G5 landed the run actions' presentation; it did not look at the request shapes)
- open PR: #14955 rewrites `openGuiWindow.ts` and the controller's `confirmAccept`; it leaves both request shapes and both dispatchers

**Evidence.**

- Two request kinds carry "compare / accept / merge / latexdiff over a base
  and an edited file":
  - `fileAction` (`shared/session/hostRequest.ts:37-42`, `:199-206`):
    `compareOriginal | latexdiff | accept | merge`, with `file`, `base` and
    `runId`. Sent by `ui/progress/components/FileList.ts:377`.
  - `latexdiffs` (`hostRequest.ts:91-105`): `latexdiff | merge | compare |
    accept`, plus three commit verbs, with `baseFile`, `editedFile`, `commit`.
    Sent by `ui/progress/components/LatexDiffsSection.ts:221`.
    One verb has two names: `compareOriginal` (`hostRequest.ts:38`,
    `FileList.ts:420`) and `compare` (`hostRequest.ts:102`,
    `LatexDiffsSection.ts:57`).
- Two dispatchers route them to the same methods:
  - `ProgressDocumentTaskFileActionsController.handle`
    (`ProgressDocumentTaskFileActionsController.ts:89-102`) for `fileAction`,
    reached through `openGuiWindow.ts:612-619`, which peels `latexdiff` off
    first (`request.action === 'latexdiff' ? latexdiff.file(...)`) and
    respreads the request (`{ ...request, action: request.action }`) to
    narrow its type.
  - The local `latexdiffs` function in `openGuiWindow.ts:440-477` for the
    sheet, which calls `compareOriginal`, `acceptFile`, `mergeFile` and
    `latexdiff.file` again.
- The base-and-edited guard is written twice on one path:
  `openGuiWindow.ts:458-462` and `latexdiffVerbs.ts:102-107`, both
  "Choose a base file and an edited file first."
- `mergeFile` only forwards (`ProgressDocumentTaskFileActionsController.ts:163-165`:
  `return this.deps.runs.merge(base, file)`), and `compareOriginal` only adds
  a title (`:134-140`).
- The run-wide latexdiff is a gate and a verb the caller sequences:
  `openGuiWindow.ts:628-631` calls `runActions.documentTaskDiffRequest`
  (`hostRunActions.ts:431-436`, which only checks) and then
  `latexdiff.run`. `documentTaskDiffRequest` has that one caller
  (`grep -rn documentTaskDiffRequest packages/*/src`: 1 outside its file).

**The design decision behind it.** "Which file verbs exist and how one is
asked for" is answered by each UI component that sends one, and each host
dispatcher re-answers it.

**The better design.** One `fileAction` request, `{ action: 'compare' |
'accept' | 'merge' | 'latexdiff', file, base, runId: optional nullable }`,
sent by both components; the sheet's `latexdiffs` keeps only the three
commit verbs (`latexdiffvc`, `packLatexdiffvc`, `cleanLatexdiffvc`), whose
`LatexdiffCommitAction` (`latexdiffVerbs.ts:51-55`) is then the whole
literal set. The controller's `handle` is the one dispatcher, takes
`latexdiff` too (it already holds the window's verbs through `runs`), and
checks the pair once. Deleted: the `latexdiffs` function in
`openGuiWindow.ts` (38 lines), `mergeFile`, the `compareOriginal` method
(inlined into `handle`), the `latexdiff` peel and respread in the
`fileAction` case, the second guard. `latexdiff.run` does its own
`requireAction(runId, 'files')` and saved-config check, and
`documentTaskDiffRequest` is deleted.

**What we give up, and risk.** The sheet's `accept` passes no run today, so
it sends `runId: null` and gets no launcher note, as now. A wire literal is
renamed (`compareOriginal` to `compare`); the host request is not persisted.

**How I tried to refute it.** Looked for a host that answers `latexdiffs`
differently: neither host binds it (`OWN_REQUEST_LABEL`,
`openGuiWindow.ts:119-126`, does not list it). Checked whether the two
components need different shapes: both hold a base and an edited path; only
`FileList` holds a run. No dated note covers the request shapes
(`grep -rn "compareOriginal\|latexdiffs" .agents/docs`: none).

## TC-2: A pack or clean result has three types and two message functions; `FileOpResult` only renames the harness's result

- flags: information leakage, repetition, comment restates code (false comment)
- package: texra (`shared/session/hostRequest.ts`, `controllers/session/hostRunActions.ts`, `controllers/session/openGuiWindow.ts`, `housekeeping/packLatexdiffvc.ts`)
- kind: refactor
- size: S
- earlier: G4 (landed, #14794) cut `FileOpResult` to `success | noFiles`. The harness's `RunFilesResult` arrived after it (#14896, 2026-11-10), so the app type is now a second representation of a harness type, which G4 did not have.
- open PR: none touches these lines

**Evidence.**

- The harness owns the result: `RunFilesResultSchema`
  (`packages/harness/src/shared/session/runtimeRequest.ts:160-168`),
  `done { to? } | noFiles | error { error }`.
- The app renames it: `FileOpResult` (`shared/session/hostRequest.ts:243-249`),
  `success { outputFolder? } | noFiles`, filled by translation in
  `hostRunActions.ts:474-485` (`result.status === 'done' ? { status:
  'success', outputFolder: result.to } : result`) and read once, by
  `fileOpResultMessage` (`openGuiWindow.ts:248-259`). It sits in the wire
  module `hostRequest.ts` though no request or outcome carries it
  (`grep -rn FileOpResult packages/*/src`: 3 importers, none a schema).
- A third type derives from the second: `LatexdiffPackResult`
  (`housekeeping/packLatexdiffvc.ts:24-28`) is `Extract<FileOpResult, ...>`
  plus `cleaned | processed`, with its own message function
  `latexdiffPackMessage` (`:32-45`). Its comment
  (`:17-23`) says it shares the shapes "with the housekeeping pack/clean
  commands (opResults.ts)": `packages/harness/src/shared/schemas/opResults.ts`
  holds no pack result any more (it holds `ExecResult` and the close
  result), and the run pack is `run.files` in the harness.
- `DocumentTaskFileOperationResult` (`hostRunActions.ts:65-68`) wraps the
  renamed result with `inputFile` only so the message can name it.

**The design decision behind it.** "What a pack or clean did, in words" is
decided by two message functions over three spellings of one outcome.

**The better design.** `documentTaskFileOperation` answers the harness's
`RunFilesResult` (its `error` case already becomes `Rejected` there) and the
one message function takes it; `LatexdiffPackResult` becomes its own
four-case union with no `Extract` from an app wire module. Deleted:
`FileOpResult` (3 importers), the translation, the false comment.

**What we give up, and risk.** Nothing user-visible; the message text stays.

**How I tried to refute it.** Checked that nothing decodes `FileOpResult`
(it is a `type`, no schema) and that no UI component reads it
(`grep -rn FileOpResult packages/texra/src/ui`: none).

## TC-3: Why the service cannot be reached is three optional flags and a sentinel reason string, and the client restates "transport failure" at six sites

- flags: conjoined methods, non-obvious code, repetition
- package: texra (`controllers/server/client.ts`, `controllers/server/serviceSession.ts`); cli (`commands/service.ts`)
- kind: refactor
- size: M
- earlier: none. `2026-11-06-cli-service-root-causes.md` §2.1 names `NOT_YET_UP` among the upgrade handoff's parts; its chosen design (one service per root) landed and kept the sentinel. Nothing earlier names the flags.
- open PR: #14959 touches `controllers/server/discovery.ts` only

**Evidence.**

- `ServiceUnavailable` (`controllers/server/client.ts:114-135`) carries its
  kind in three optional fields that are never set together:
  `newer?: true`, `unspoken?: string` (a socket), `unanswered?: true`. Each
  consumer tests one: `client.ts:394` and `packages/cli/src/commands/service.ts:187`
  (`error.unspoken !== undefined`, then `error.unspoken ?? ''` because the
  test did not narrow), `client.ts:456` (`unanswered === true`),
  `client.ts:466` and `:668` (`newer === true`).
- A fourth kind is a reason string: `NOT_YET_UP = 'not yet up'`
  (`client.ts:146`) is the `reason` of a placeholder error (`:453`, `:462`),
  compared at `:485` (`error.reason === NOT_YET_UP`) to decide which message
  the timeout shows. The reconnect loop then dedupes refusals by comparing
  `error.message` strings (`told`, `client.ts:655-666`).
- Six sites turn "the RPC transport failed" or "the link holds no client"
  into a message, each with its own structural type for the client error:
  `asked` (`serviceSession.ts:95-110`, `Predicate.isTagged(error,
  'RpcClientError')`), `serviceProjectState`'s `call` (`:126-149`, the
  inline type `{ readonly _tag: 'RpcClientError'; message: string }`),
  `refusedByService` (`:244-254`, the same inline type, and a different
  wording: the start's transport failure reads "could not start the task:
  …", every other call "did not answer: …"), `request` (`:423-433`),
  `answered` (`:377-392`), and `callService` (`:77-85`) for the offline half.

**The design decision behind it.** "What kind of failure is this" is decided
by which optional field happens to be set, or by string equality, instead
of by the error's type.

**The better design.** `ServiceUnavailable` gets a `kind` field
(`Schema.Literals(['newer', 'unreadable', 'unanswered', 'notYetUp',
'failed'])`) with `socket` required on `unreadable`, as a
`Schema.Union` of tagged structs; `catchIf((e) => e.kind === 'unreadable')`
narrows, the `?? ''` goes, and the timeout's message is chosen by
`kind === 'notYetUp'`. `callService` maps `RpcClientError` too, so a call
site supplies only its error class: `asked`, `call`'s branch,
`refusedByService`'s inline type and `request`'s `RpcClientError` case go,
and every transport failure is worded once.

**What we give up, and risk.** None at the wire: `ServiceUnavailable` never
crosses the socket (the procedures fail with `TaskFailed`, `LaunchRefused`,
`ProjectStateFailed`). The start's message wording changes to the shared one.

**How I tried to refute it.** Checked for a combination of flags: every
constructor sets at most one (`client.ts:234-243`, `:362-365`). Checked the
CLI's other catch (`commands/service.ts:125`), which only prints `message`
and is unchanged.

## TC-4: "Create agent" checks the name with its own rules, which admit names the agent schema refuses, so the new agent never loads

- flags: repetition, information leakage
- package: texra (`controllers/settingsView/settingsAgentCommands.ts`); harness (`shared/schemas/agent.ts`, the `./schemas` entry)
- kind: bug
- size: S
- earlier: none (round 5's docs report compared the creator's prose with `AGENT_NAME_IDENTIFIER`, not this check)
- open PR: none

**Evidence.**

- The definition schema owns the rule: `AGENT_NAME_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/u` and `AgentNameSchema`
  (`packages/harness/src/shared/schemas/agent.ts:36-40`), the `name` of
  `AgentDefinitionSchema` (`:148-149`), which the catalog scan decodes every
  agent file with (`packages/harness/src/agent/index/agentYamlScanner.ts:100`).
- The settings Agents page writes a new agent file after its own check,
  `validateTemplateAgentName` (`controllers/settingsView/settingsAgentCommands.ts:47-58`):
  not empty, no `/` or `\`, no space, none of ``:#[]{}|>&*!%@` ``. It then
  writes `name: <input>` into the template (`:66-97`,
  `agent/templates/agentTemplates.ts:19-30`).
- Names the check accepts and the schema refuses: `my.agent`, `-draft`,
  `_x`, `résumé`, `a+b`, `x(1)`, and `foo.yml` (only `.yaml` is stripped,
  `:70-72`, so the file is `foo.yml.yaml` with `name: foo.yml`). Each becomes
  a file the scan reports as an issue (`customAgentIssues`, `:148`) and no
  agent appears; the editor has already opened it (`:405`) and nothing says
  the name is the problem.

**The design decision behind it.** "What is a valid agent name" has two
owners, and the one the user meets is the looser.

**The better design.** Export `AgentNameSchema` from
`@texra-ai/harness/schemas` and decode the input with it
(`Schema.decodeUnknownResult`), showing the schema's message, or a one-line
message naming the allowed characters. `validateTemplateAgentName` (1
caller) is deleted. The suffix strip takes `.yml` too, or the schema refuses
the dot.

**What we give up, and risk.** One more export on the harness's public
schemas surface (an API report diff). A name with a dot that some user
expects is refused up front instead of failing later.

**How I tried to refute it.** Checked whether the scan derives the name from
the file name instead of the `name` key (it decodes the key with
`AgentDefinitionSchema`, `agentYamlScanner.ts:100`). Checked for a second
check before the write (none: `createAgent`, `settingsAgentCommands.ts:384-408`).

## TC-5: The git reads have one owner except a commit lookup and the commit log; the lookup runs two processes with no timeout for a yes/no

- flags: repetition, overexposure, shallow module, comment restates code (false comments)
- package: texra (`utils/git/`); extension (`progressView/findCommit.ts`)
- kind: refactor
- size: S
- earlier: remainder of `implemented/simplification/2026-11-03-git-reads-and-subscription-facts-overlap.md` item 1 (done, #14742), which made `gitReads.ts` the owner and listed `repositoryOverview.readGit` among the duplicated runners; `findCommitInHistory` was not in its table (T-app-surfaces Finding 10 named it only as a command nothing registers)
- open PR: none

**Evidence.**

- `gitReads.ts:1-13` claims every host and tool asks its reads there "so a
  fix (a timeout) is made once"; `gitValue` (`:25-38`) runs with
  `GIT_READ_TIMEOUT_MS`.
- `findCommitInHistory` (`packages/extension/src/progressView/findCommit.ts:11-53`)
  runs its own `executeCommand(['git', …])` twice with no timeout: `rev-parse
  --verify <hash>^{commit}`, then `git show -s --format=<COMMIT_LABEL_FORMAT>`
  for a label. Its one caller (`extensionHostRequests.ts:244-258`) reads the
  answer only for truthiness (`if (commitLabel)`), so the second process and
  the label are dead. It also guards `typeof commitHash !== 'string'` on a
  parameter typed `string` (`:16`).
- `repositoryOverview.readGit` (`utils/git/repositoryOverview.ts:42-58`) is a
  second runner beside `gitValue`, with the same 10 s timeout and its own
  failure policy, for one read (`readRecentCommits`, the file's only export,
  one caller `controllers/session/hostSnapshotSource.ts:328`).
- `utils/git/commitLogFormat.ts` exports `COMMIT_LABEL_FORMAT` and
  `splitCommitLines`; after the dead label above, both have the one consumer
  `repositoryOverview.ts`. Its comment says the extension and the desktop
  main process each build labels from it; neither does now.
- False comments in `repositoryOverview.ts`: the header (`:1-17`) names an
  "environment-summary" surface and "the desktop workspace header" and the
  modules it replaced; the buffer comment (`:30-34`) names "numstat totals".
  The file reads neither: it has one read, the commit log.

**The design decision behind it.** "How TeXRA runs a git read" has three
owners (two runners and an inline pair of calls), so the timeout the owner
module promises is not everywhere.

**The better design.** `gitReads.ts` gains `commitExists(cwd, hash)` (one
`rev-parse --verify`, through `gitValue`) and `recentCommitLabels(cwd,
limit)` (through `gitValue`, splitting lines inline). Deleted:
`findCommit.ts` (53 lines), `repositoryOverview.ts` (91), `commitLogFormat.ts`
(19), and `COMMIT_HASH_PATTERN`'s one external use moves into
`commitExists`. The extension's caller writes
`if (yield* commitExists(root, parsed.commitHash))`.

**What we give up, and risk.** `readGit` logs a failed `git log` at `warn`;
`gitValue` answers null quietly. The caller already says "not a repository"
from the probe, so the warning has to move to it to stay.

**How I tried to refute it.** Looked for another reader of the label
(`grep -rn findCommitInHistory`: one caller, boolean use). Looked for a
desktop use of `commitLogFormat` or `repositoryOverview` (none:
`grep -rn "utils/git/" packages/desktop/src` finds no import of either).

## TC-6: The app serves its command directories as the harness's `CommandDirs`, then four callers bypass the service and read a module-level cache

- flags: information leakage, non-obvious code, repetition
- package: texra (`platform/defaults/commandDirs.ts`, `controllers/texraProcessLayer.ts`, `tools/media/audio.ts`, `tools/agentCli/vendorPackages.ts`); extension (`frontend/setup.ts`); desktop (`main/desktopPtyHost.ts`)
- kind: refactor
- size: S
- earlier: M8 (landed, #14802) made `CommandDirs` a `Context.Reference` the app provides; G11 h (landed, #14874) moved the app's other probe caches behind `Context.Reference`s. This cache and the direct reads are the remainder of both.
- open PR: none

**Evidence.**

- The harness's port: `CommandDirs = Context.Reference<() => readonly
  string[]>` with `withCommandDirs` (`packages/harness/src/utils/system/platformPaths.ts:36-39`,
  `:111-115`). The app provides it once per process:
  `Layer.provideMerge(Layer.succeed(CommandDirs)(commandDirs))`
  (`controllers/texraProcessLayer.ts:123`).
- Four callers import the function instead and extend PATH by hand:
  `tools/media/audio.ts:183` (`withExtendedPath(yield* inheritedEnv(),
  commandDirs())`, inside an Effect that has the service),
  `tools/agentCli/vendorPackages.ts:231` (inside `Effect.fn`, same),
  `packages/extension/src/frontend/setup.ts:26-29` (inside `Effect.sync`),
  `packages/desktop/src/main/desktopPtyHost.ts:119` (a plain function at
  the host edge). The harness's own readers all `yield* CommandDirs`
  (`pluginHooks.ts:201`, `:275`; `pluginDigest.ts:142`).
- Under both paths sits `let cachedExtraDirs: string[] | null`
  (`platform/defaults/commandDirs.ts:17`, `:80-82`, `:261-262`), the area's
  one remaining module-level mutable value: computed by whichever caller
  runs first, returned by reference as `readonly string[]`. The harness's
  comment on the consumer (`platformPaths.ts:65-71`) promises a directory
  created mid-session is on the next command's PATH; that holds for a
  listed directory, but the glob roots (`texlive/*/bin/*`, `scoop/apps/*`,
  `gs/*/bin`) are expanded once, so a TeX Live or Ghostscript installed
  after the first spawn is not found until restart.

**The design decision behind it.** "Which directories TeXRA adds to PATH"
is computed once and then reached two ways; the Effect callers do not use
the service the process layer already gives them.

**The better design.** `audio.ts` and `vendorPackages.ts` call
`withCommandDirs` / `whichOnExtendedPath(name, (yield* CommandDirs)())`;
the extension's `extendPath` reads the service too (it runs in Effect). The
process layer computes the list in `Layer.sync` and serves `() => dirs`, so
the module cache goes; the desktop pty, outside Effect, takes the list from
its host's runtime when it builds the pty. Deleted: `cachedExtraDirs` and
three direct imports. Whether the glob roots are re-expanded per call is a
separate decision (cost: a few globs per spawn).

**What we give up, and risk.** The desktop pty needs the list passed in;
one more parameter at its construction.

**How I tried to refute it.** Checked whether the direct callers run where
the service is unavailable: `audio.ts` and `vendorPackages.ts` run inside
tool Effects under the process layer; only the pty is outside Effect.

## TC-7: Which agents lead a built-in team is an option every caller passes as the same constant

- flags: overexposure, pass-through, special-general mixed
- package: texra (`agent/teams/teamPlan.ts`, `agent/teams/teamLaunch.ts`, `controllers/mainView/teamCatalogPorts.ts`); cli (`commands/team.ts`)
- kind: refactor
- size: S
- earlier: none (`grep -rn rootAgentNames .agents/docs`: no hit)
- open PR: #14955 and #14949 edit `teamLaunch.ts` (the refusal shape, the launch copy); neither touches the option

**Evidence.**

- `TeamRunOptions.rootAgentNames` (`agent/teams/teamPlan.ts:63-77`) is "the
  agents a built-in team runs as its root, in preference order", read only
  by `selectTeamRootAgent` (`:113-129`) and only for a non-custom team
  (`:121`: a custom team returns before it is read).
- Every production caller passes the one constant
  `BUILTIN_TEAM_ROOT_AGENT_NAMES` (`shared/constants/agents.ts:10-14`):
  `teamPlan.ts:158` (`applyTeam`), `controllers/mainView/teamCatalogPorts.ts:18`
  (spread into `resolveTeamLaunch` and `loadTeamOptions` by its three
  callers), `packages/cli/src/commands/team.ts:74` and `:101`. The one other
  value is a test's `rootAgentNames: []` for a custom team
  (`src/test-kernel/shared/TeamLaunch.vitest.ts:47`), where it is never read.
- So the constant travels through `createTeamCatalogPorts`, the
  `Omit<TeamRunOptions<T>, 'agentOverride'>` of `resolveTeamLaunch`
  (`teamLaunch.ts:175-183`), and two CLI call sites to the one function that
  could import it.

**The design decision behind it.** "Which agent leads a built-in team" is a
fact of the bundled teams, decided at every call site instead of beside the
teams.

**The better design.** `selectTeamRootAgent` reads
`BUILTIN_TEAM_ROOT_AGENT_NAMES` itself; `rootAgentNames` leaves
`TeamRunOptions`; `createTeamCatalogPorts` returns `presets` and
`resolveAgent` only, and the CLI's two calls drop the line and the import.
Deleted: one option, five passings, two imports.

**What we give up, and risk.** A test cannot inject another preference
order; none needs to (the one test passes `[]` where it is not read).

**How I tried to refute it.** Looked for a host or plugin that names other
roots (a Lean plugin's team, say): `leanOrchestrator` is already in the
constant, and no caller builds another list (`grep -rn rootAgentNames
packages/*/src`: the five sites above and the reader).

## TC-8: The chat export's input loader answers four fields its two callers re-derive from, and declares schemas nothing decodes

- flags: overexposure, repetition, comment restates code (false comment), conjoined methods
- package: texra (`agent/export/loadChatExportInput.ts`, `agent/export/schemas.ts`, `agent/export/chatExport/formatSpec.ts`, `controllers/progressView/ChatExportController.ts`); cli (`runtime/history.ts`)
- kind: refactor
- size: S
- earlier: none for this path. HS-1 (this round) covers the HTML trace export's result; this is the Markdown and LaTeX path beside it. The lens IC finding on `loadChatExportInput.ts:18` (a "#7246 Decision 1" citation) landed.
- open PR: none

**Evidence.**

- `ChatExportLoadResult` (`agent/export/loadChatExportInput.ts:52-58`) is
  `{ run, config, conversation, exportInput }`, with `exportInput` null
  "whenever there is nothing (or not enough) to export; callers distinguish
  … using `run`/`config`/`conversation` themselves" (`:45-51`). The two
  callers read only `config` and `exportInput`:
  `controllers/progressView/ChatExportController.ts:119-130` (`!config` → "no
  saved data", `!exportInput` → "no conversation") and
  `packages/cli/src/runtime/history.ts:271-284` (`exportInput`, then
  `!exists && !config`). `run` and `conversation` have no reader outside the
  loader. The status the callers reconstruct (no config / no conversation /
  ok) is a union written as nullable fields.
- `ExportConfigSchema` and `ChatExportInputSchema`
  (`agent/export/schemas.ts:22-47`) are never decoded:
  `grep -rn ChatExportInputSchema packages/*/src src`: the declaration only;
  `ExportConfigSchema` is used only to build it. The header (`:8-11`) says
  the shapes are schemas because "the conversation's nodes cross the
  service's RPC edge"; what crosses is the harness's `ExportNodeSchema`
  (`controllers/server/protocol.ts:189`), not these.
- `ExportConfig` restates seven `AgentConfig` fields, copied one by one in
  `loadChatExportInput.ts:105-113` and read by `formatSpec.ts:39-64`.
- `ChatExportInputUnreadable.part` (`:35-46`) is a literal nothing branches
  on (`grep -rn "\.part\b" packages/texra/src packages/cli/src`: none for it).

**The design decision behind it.** "Can this run be exported, and if not,
why" is answered by the loader as four nullable fields and decided again by
each caller.

**The better design.** `loadChatExportInput` answers a tagged result:
`{ _tag: 'ready', input }`, `{ _tag: 'noConfig' }`, `{ _tag: 'noConversation' }`;
the GUI maps the two refusals to its sentences, the CLI adds its `exists`
read for `not_found`. `ExportConfig` becomes `Pick<AgentConfig, …>` and the
seven-field copy goes; the two schemas become plain types and the false
header goes; `part` folds into `message`. Deleted: `ChatExportLoadResult`,
two schemas, one literal field.

**What we give up, and risk.** None at a boundary: nothing persists or sends
`ChatExportInput`.

**How I tried to refute it.** Looked for a decode of either schema in the
CLI, the desktop and the tests (none), and for a reader of `run` (the loader
computes it for the timestamp only, `:102-104`, which stays inside).

## TC-9: Every inbound settings and desktop message has a schema, and every sender posts an untyped `(command: string, payload: Record<string, unknown>)`

- flags: information leakage, non-obvious code
- package: texra (`shared/hostBridge.ts`, `shared/settingsView/settingsViewMessages.ts`); extension (`settingsView/frontend/`, 53 call sites); desktop (`renderer/`, about 19 call sites)
- kind: refactor
- size: M
- earlier: none (`grep -rn "postMessage(command\|hostBridge" .agents/docs`: J-ui-kit names `hostBridge.postMessage` only as an RPC transport for the progress view)
- open PR: #14949 and #14953 edit `settingsViewMessages.ts` (field shapes); none touches `hostBridge.ts` or the senders

**Evidence.**

- The receiver decodes against a schema union:
  `SettingsViewInboundMessageSchema` (`shared/settingsView/settingsViewMessages.ts`),
  decoded at `packages/extension/src/settingsView/SettingsViewProvider.ts:261-262`
  and `packages/desktop/src/main/desktopSettingsIpc.ts:178`; each member names
  its fields, e.g. `SET_ALL_AGENTS_ENABLED` `{ source: AgentSourceSchema,
  enabled: Boolean }` (`:560-564`), `SET_MODEL_REASONING_LEVEL` `{ level:
  NullOr(ReasoningEffortSchema) }` (`:543-550`).
- The sender is `postMessage(command: string, payload: Record<string,
  unknown> = {})` (`shared/hostBridge.ts:28-33`): the compiler links neither
  the command to its payload nor the payload to the schema. 72 calls go
  through it (`grep -rn "postMessage(" packages/extension/src/settingsView/frontend
  packages/desktop/src/renderer | grep -v hostBridge.postMessage`). Example:
  `ModelSelectionList.ts:133-136` posts `level: value === '' ? null : value`
  with `value` a raw select string; only the host's decode says whether it
  is a reasoning level.
- A payload drift (a renamed field in one of the open PRs' schema edits, a
  typo) is a runtime decode failure in the host, logged there, with the
  click doing nothing in the view.

**The design decision behind it.** "What a command carries" is stated by the
schema and restated, unchecked, at every send.

**The better design.** A typed sender per surface:
`post(message: SettingsViewInboundMessage)` for the settings view (the type
is `typeof SettingsViewInboundMessageSchema.Encoded`, already exported), and
the same over the desktop's inbound union for the renderer.
`postMessage(command, payload)` is deleted. Each call site writes
`post({ command: SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED, source,
enabled })`, and the select handlers decode their string to the field's
type before sending.

**What we give up, and risk.** A mechanical edit of about 72 lines across
two packages. The host still decodes (the webview is a boundary), so no
check is removed.

**How I tried to refute it.** Checked whether the senders already pass
through a typed helper (the settings `stateSettingRows.ts:48` helper wraps
the same untyped call). Checked the progress view: it posts typed
`UpMessage`s through `SessionBridge`'s frames, so only the settings view and
the desktop renderer are affected.

## TC-10: "Which input does a model-reported document name" has two matchers that disagree on an ambiguous name, and a third rule in one of their two consumers

- flags: information leakage, repetition, non-obvious code
- package: texra (`agent/output/lineageMapping.ts`, `agent/output/outputFileExtraction.ts`, `agent/output/diffComputation.ts`, `agent/output/fileMapping.ts`)
- kind: bug
- size: S
- earlier: remainder of I2 (landed, #14796), whose design said to fold the single-input fallback into `pairOutputsWithBases` "as a rule, or refuse"; it is still in `diffComputation.ts`. The 2026-11-14 reply-document note (§2) lists `similarityBaseFiles` among the recovery steps it may delete; it does not compare it with `findMatchingBaseFile`.
- open PR: none (#14953's edits to these files are the `readNormalizedFile` swap, merged)

**Evidence.**

- `findMatchingBaseFile` (`agent/output/lineageMapping.ts:130-152`) tries
  six matchers in order, four of them basename-only ("for legacy outputs
  that report just a filename", `:127-129`), and returns the first base
  that matches. Two bases `a/main.tex` and `b/main.tex` and a reported
  source `main.tex` pair the output with whichever base is listed first.
- `similarityBaseFiles` (`agent/output/outputFileExtraction.ts:65-94`)
  answers the same question for the previous round's outputs and refuses
  exactly that case: a suffix match counts only "when it is unambiguous"
  (`:73-76`, `basesMatching(source) === 1`).
- `pairOutputsWithBases` (`lineageMapping.ts:160-191`) feeds two consumers.
  `computeOutputDiffStats` adds a rule of its own: with one base and no
  match, the output is paired with that base (`diffComputation.ts:140-151`).
  `replaceInputCommands` does not (`fileMapping.ts:51-55`), and keys its map
  by base, so in the ambiguous case above the second `main.tex` output
  overwrites the first (`baseToOutputMap.set(basePath, location)`), and one
  output's `\input` lines are rewritten to the other's path. Its comment
  (`:30-33`) promises "two bases that share a file name in different
  directories each keep their own output", which holds only when the model
  reports full paths.

**The design decision behind it.** "Which input file does this document
name revise" is answered by two functions with different ambiguity rules,
and one consumer adds a fallback the other lacks.

**The better design.** One `baseOf(bases, source)` in `lineageMapping.ts`
that answers a base, or none when the name is ambiguous or unknown, with the
one-base rule inside it (or refused, as I2 proposed). `similarityBaseFiles`
and `pairOutputsWithBases` both call it; `diffComputation.ts`'s fallback
block and the four basename matchers' first-wins order go, and an ambiguous
name is logged once and recorded as a new document, as an unpaired output
already is (`diffComputation.ts:157-160`).

**What we give up, and risk.** A run whose model reports bare names for two
same-named inputs gets no lineage for them instead of an arbitrary one. A
regression test (two `main.tex` bases, bare sources) is the one test this
earns, written to fail first.

**How I tried to refute it.** Checked whether extraction already refuses
duplicate basenames before pairing: `filenameHeaders` matches against
`ExpectedDocuments`, which may hold both paths; nothing upstream dedupes by
basename. Checked the single-base fallback's absence in the rewrite: with
one base, one output and no name match, the `\input` rewrite leaves the
output's `\input`s unrewritten while its diff pairs it, which is the
inconsistency, not a guard.

## TC-11 (batched): Smaller instances of one owner per fact: a dead module, a one-implementation port, a fact carried twice, a type restated as a schema, and false comments

- flags: overexposure, shallow module, repetition, comment restates code (false comments)
- package: texra
- kind: refactor
- size: S
- earlier: none for these lines
- open PR: none

**Evidence and the fix, by item.**

a. **A dead module.** `platform/disposable.ts` exports `Disposable`; no file
imports `@texra/platform/disposable` or a relative path to it
(`grep -rn "disposable'" packages/*/src src packages/*/test`: none). Delete
the file.

b. **Exports with no consumer outside their file.** `EventInput`
(`shared/session/sessionFrames.ts:54`, used nowhere, in its file
included), `HostFrameSchema` (`:84`, used only at `:212`),
`MissingLatexTool` and `InstallCommand`
(`shared/constants/latexToolchain.ts:491`, `:629`), `ChatExportInputSchema`
(see TC-8). Drop the `export`s, and the unused type.

c. **A port with one implementation that only carries a record.**
`ServiceControl` (`controllers/server/service.ts:85-104`) is a
`Context.Service` built once, in `serve.ts:192-217`, and read once, by
`serviceHandlers`; its `version` is always `BUILD_VERSION`, which
`service.ts` could import as `serve.ts` does
(`grep -rn ServiceControl packages/*/src packages/*/test src`: these two
files). `serviceHandlers` becomes a function of the control record
(`serviceHandlers(control)`), and the tag goes.

d. **A fact carried twice.** `CompileCheckContext` (`agent/output/compileCheck.ts:45-54`)
holds `runId` beside `fileService`, which carries the same run's id; the
module reads both (`:241` `ctx.fileService.runId`, `:351` `ctx.runId`).
Its one caller fills both from different sources
(`tools/documents/documentTools.ts:376`). Keep `fileService.runId`.

e. **A type restated as a schema.** `GenericDiagnostic` is an interface
(`utils/diagnostics/diagnosticFormatting.ts:14-25`) and
`controllers/server/hostCalls.ts:23-33` writes the schema beside it,
`satisfies Schema.Codec<GenericDiagnostic, unknown>`, with severity as a
union of four `Schema.Literal`s; `ManualCriticismEntrySchema` (`:35-41`)
does the same for `tools/editorHost.ts`'s type. The schema should be the
owner and the type derived (`typeof S.Type`), the severity
`Schema.Literals([0, 1, 2, 3])`.

f. **False comments.** `agent/output/outputFileExtraction.ts:4` says the
module "waits for workspace preparation"; nothing in it waits for or
prepares anything. `controllers/session/SessionBridge.ts:92-101` ends
with the history of the channel ("The last case that widened it to
`Error` was the transcript export; its steps carry tags now"), which
states no reason a reader needs. `common/secrets/storeCredential.ts:56-58`
says the CLI, the desktop app and the extension share it; it has two
importers, both in the settings body
(`controllers/settingsView/settingsGitCommands.ts:8`,
`SettingsProfileKeyController.ts:6`), which the CLI reaches through
`SettingsProfileKeyController`, so the claim holds only by that path and
the comment should say so.

**What we give up, and risk.** Nothing user-visible.

**How I tried to refute it.** For each export, grepped production, tests
and scripts (`scripts/` included, since `catalog.ts`'s three exports that
looked unused are read by `scripts/sync-package-contributes.mjs` and were
dropped from this list).

## Good modules in this area

- **`controllers/server/protocol.ts`.** One `RpcGroup` for the whole
  service, the payloads the runtime's own schemas, the record procedures
  generated from `RUN_RECORDS` with a `satisfies` that ties each to
  `RunRecords`, and the protocol's identity a digest of every procedure's
  JSON Schema. A shape change cannot ship without changing the digest.
- **`controllers/server/serve.ts`.** The service's lifetime is one
  `SubscriptionRef` (`leaving`, `admitting`) and the projects' load, zipped;
  drain and idle are stream predicates over published facts, and an
  admission is claimed in the same `modify` that checks for a leave.
- **`controllers/server/hostCalls.ts` + `windowHost.ts`.** A host capability
  is a member of one call union; the capabilities a window offers are
  derived from the members it has, and `ANSWERED` says which calls a run
  waits on and for how long, in one table.
- **`utils/git/gitReads.ts`.** Five reads behind one runner with one
  timeout and a "never fails, answers null" contract (TC-5 asks the last two
  git callers to join it).
- **`agent/output/documentRecipe.ts`.** A document task is a config patch:
  the recipe source, its tools and its decoded options, built from the
  catalog entry, with the one refusal typed.
- **`utils/diagnostics/recoverLogged.ts`.** The one way an optional step's
  typed failure becomes a fallback: the report is mandatory, defects and
  interruption pass through.

## Already settled, left alone

- The subscription-usage adapters' alias readers
  (`controllers/modelAccess/subscriptionUsage/subscriptionUsageParsing.ts`):
  U (round 3, "Already settled") kept them as a provider boundary.
- `UsageLogService`'s sender state: G9 (landed, #14810) chose the current
  shape.
- Opening a project's roots per host, the setup launch's outcomes per host,
  the settings view's run verbs, and `LatexToolingController`'s seven tool
  paths: open items 1, 3, 5 and app fact 5 of
  `.agents/docs/proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md`.
- The reply-document recovery steps (`replyDocuments.ts`,
  `contentSimilarity.ts`): §2 of
  `.agents/docs/proposed/simplification/2026-11-14-llm-history-lowering-and-reply-document-recovery.md`,
  pending its evidence. TC-10 is only the base-matching rule beside it.
- The upgrade handoff (`client.ts`'s retire-and-wait, `serve.ts`'s drain):
  `.agents/docs/proposed/architecture/2026-11-06-cli-service-root-causes.md`
  §2.1, the chosen "one service per root" design, landed. TC-3 is only the
  error's shape.
- The session bridge's `held` queue: V S15, kept (catalogue G7 row).
- The latexdiff and LaTeX toolchain catalog (`shared/constants/latexToolchain.ts`):
  I10 (landed, #14790).
- Plain-names words in this area (`OwnHostArms`, "arm" in
  `openGuiWindow.ts`; `ServeOptions.settle` in `serve.ts`): the names lens
  (LC this round; `names.md` earlier) counts them.
