# LI: information leakage and repetition across package boundaries

Read-only lens audit. Read on `main` at `d70ad92` (the working tree adds only
this folder's reports). Lens: one fact decided in two packages, and
hand-written versions of what Effect, SQLite, Node or an installed package
provides. Earlier passes over the same flags, read first and not repeated:
`../2026-11-08-design-red-flags-lenses-2/README.md` section 7,
`../2026-11-07-design-red-flags-round-3/U-cross-package.md`, and
`.agents/docs/proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md`.
Open PR #14955 (`claude/clever-pascal-h5a0xm`, with its note
`2026-11-15-layer-misplacements-left-open.md`) and #14949
(`claude/dazzling-cori-84lvx0`, note `2026-11-15-data-shapes-left-after-the-audit.md`)
were diffed; #14950, #14953 and #14954 are merged at `d70ad92`. The
finished area reports in this folder (CL, HR, HS, HT, LM, TC, TT, TU) were
skimmed and their findings are not repeated.

## Numbers

Lines of `.ts`/`.tsx` under each package's `src/`:

| Package      |  Lines |
| ------------ | -----: |
| texra        | 81,527 |
| harness      | 79,150 |
| cli          | 44,932 |
| extension    | 15,758 |
| desktop      | 14,491 |
| llm          | 12,094 |
| trace-viewer |    407 |

Five largest files: `harness/src/shared/session/sessionViewUpdate.ts` (1078),
`harness/src/agent/runtime/loop/toolUseDispatch.ts` (1011),
`cli/src/chat/chatSessionController.ts` (1007),
`desktop/src/renderer/main.ts` (936),
`harness/src/agent/runtime/runRegistry.ts` (887).

**Method.** Every single-quoted literal of six or more characters and every
capitalised sentence literal was collected per package and intersected
across packages (772 literals and 70 sentences appear in two or more
packages); function names defined in two packages were listed the same way
(40). Most shared literals are members of a typed vocabulary (a
`Schema.Literals` set, a `Record<K, …>` key, a command id) and compile
against one owner; those were dropped. What remains was read in full.

**Result.** The landed lens-2 section 7 items hold (no new `'SKILL.md'`,
`'.yaml'`, `texra.ai`, `Revision ${…}`, `TEXRA_APPROVAL_POLICY` or
`texra-agent:` spelling outside its owner). Hand-written library code is
thin after #14946, #14948, #14951 and #14953: no hand-rolled regex escaping,
debounce, deep-equal, semver or hashing remains. What is left is facts that
the harness cannot import from the app and so restates, and a few that the
app restates from llm.

## LI-1: Where a setting is changed is written into fifteen messages in four packages, and the places they name disagree with the UIs

- flags: information leakage, repetition, special-general mixed
- package: harness (the six messages that name TeXRA's UI); texra (nine
  messages); cli and desktop (one each)
- kind: bug (three sites send the user to a page that does not exist or
  does not hold the row) and refactor
- size: S (messages name the row) to M (with one placement owner)
- earlier: I-C7 (round 5 prompts `REPORT.md` C7, landed #14834) fixed one
  wrong page in two of these strings by editing the string; the design that
  makes the next drift possible was not named, and new instances exist
- open PR: none

**Evidence.** A tool result, prompt section or alert tells the user (or the
model, which relays it on whatever host it runs) which page holds a row:

- harness, which by its own guide reads none of TeXRA's placement
  (`packages/harness/AGENTS.md` "Catalog settings": "Where TeXRA shows a row
  … are the app's … the harness reads none of it"):
  `agent/runtime/delegation/delegationAvailability.ts:130` and
  `delegation/inputFields.ts:63` ("'Subagent worktrees' in Settings > Agents
  > Advanced"), `delegationAvailability.ts:138` ("Settings → Agents"),
  > `tools/executions/killPolicy.ts:36,42` ("Settings > Agents > Advanced"),
  > `common/plugins/pluginTrust.ts:369` ("Settings > Plugins, `/plugins`, or
  > `texra plugin enable …`", a CLI binary name and slash command in the SDK).
- texra: `tools/agentCli/claudeAgent.ts:424` and
  `tools/agentCli/claudeAgentPlugin.ts:123,137` ("TeXRA Settings → API Keys
  → Anthropic"), `tools/github/githubSubscriptionTool.ts:155` and
  `tools/github/plugin.ts:58,65,84,88` ("/config → GitHub token", "Settings →
  General"), `tools/DiagnosticsTool.ts:171` ("Settings > LaTeX"),
  `controllers/settingsView/settingsAgentCommands.ts:240` ("the Agents tab
  in Settings").
- cli `runtime/models/modelAccessSelection.ts:201` ("/config → API keys");
  desktop `renderer/editorPane.ts:618` ("**Customize** in Settings").

The placement itself has three owners already:
`texra/src/shared/settings/settingSurfaces.ts` (a row's `category`, which
the CLI `/config` panel groups by, `cli/src/chat/tui/forms/configCategories.ts:13-24`),
`texra/src/shared/settingsView/settingsTarget.ts:34-41`
(`SETTINGS_PAGE_SECTIONS`, the GUI pages and sections) with their labels in
`extension/src/settingsView/frontend/settingsNav.ts:36-104`, and each GUI
tab's template, which renders its rows by hand
(`extension/src/settingsView/frontend/tabs/AgentsTab.ts:243-262`).

Where they disagree today:

1. `git.worktreeSupport` is `category: 'git'` (`settingSurfaces.ts:227-230`),
   so `/config` lists it under "Git and worktrees"; `AgentsTab.ts:257`
   renders it under Agents > Advanced; the two harness messages say Agents >
   Advanced. On the CLI the model sends the user to a "Settings" page the
   terminal does not have, for a row that `/config` files elsewhere.
2. "TeXRA Settings → API Keys → Anthropic" (three texra sites): there is no
   API Keys page; keys are Models > API keys (`settingsNav.ts:41-50`,
   `settingsTarget.ts:35`).
3. `killPolicy.ts:42` and `delegationAvailability.ts:138` speak GUI words on
   every host; `allowOrchestratorKill` is under "Tasks and agents" in
   `/config` (`settingSurfaces.ts:233-236`, `configCategories.ts:17`).

Each message also restates the row's title by hand ("Subagent worktrees",
"Let a task stop its agents", "Show criticism as editor diagnostics"),
which the row already carries (`stateSettings.ts:409,423`,
`texraSettings.ts:291`).

**The design decision behind it.** "How does a person reach this row?" is
answered in each message, by its author, in one host's words, though the
row object, its title and its placement are all in hand.

**The better design.** Two steps; the first stands alone.

1. Messages name the row, never a page: one
   `settingName(row) => \`"${row.title}" (${row.key})\``beside`SettingRow`in`harness/src/shared/state/stateSettings.ts`, used by all
   fifteen sites (the harness ones pass the row they already import:
   `GIT_WORKTREE_SUPPORT_SETTING`, `ALLOW_ORCHESTRATOR_KILL_SETTING`). The
   title is what every settings UI shows and the key is what `/config`,
   `texra config`and`.texra/config.json`take, so the pointer is right on
   every host.`pluginTrust.ts:369` keeps "enable it again" and drops the
   three host spellings. Deleted: every "Settings > …" literal in the
   harness (6), the stale "API Keys" path (3).
2. If a page is still wanted, it is derived in texra from one placement:
   `settingSurfaces` gains the GUI section (`'agents/advanced'`, a
   `SettingsTarget`) next to `category`, `AgentsTab.renderAdvanced` renders
   the rows placed there instead of a hand list, and an app message calls
   `settingLocation(row)`. This is the "typed placement key" that
   `../2026-11-07-design-red-flags-round-3/P-settings-model.md` finding 3
   proposed for `category`, and it decides finding 1 above: the CLI category
   and the GUI section become two columns of one row, visible side by side.

**What we give up, and risk.** Step 1 loses the click path a GUI user could
follow without searching. No GUI page searches setting rows (the
`SettingsCatalog` search filters agents, skills and plugins), so a title
alone is weaker in the GUI; step 2 restores the path from the owner. Prompt text
changes (the delegation section and two tool errors), so the frozen system
text of a new run changes; stored runs are unaffected.

**How I tried to refute it.** Checked whether the harness can read the
placement (it cannot: `settingSurfaces.ts` is in texra and the harness
imports nothing from the app), whether `settingsView: 'agents'` on a row is
the GUI placement (it is the rebroadcast snapshot, not the tab:
`P-settings-model.md:452`), and whether the CLI shows these rows under
"Settings" (no: `/config` groups by `category`). I-C7's fix is still
correct for the GUI; the CLI half and the API Keys path are new.

## LI-2: Running git has owners in two packages: the app's "one owner of repository reads" sits above the harness that needs the same reads, and the machine-git runner is written once in each

- flags: repetition, information leakage, overexposure
- package: harness (`utils/system/`, `agent/prompt/workspaceInfo.ts`,
  `controllers/session/appStateStore.ts`, `common/plugins/pluginGit.ts`);
  texra (`utils/git/gitReads.ts`, `latex/overleafClone.ts`); cli
  (`runtime/gitOps.ts`)
- kind: refactor
- size: M
- earlier: TC-5 (this folder) covers the texra and extension half (the
  commit lookup and `repositoryOverview.readGit`); the 2026-11-03
  git-reads note (implemented, #14742) made `gitReads.ts` the owner inside
  the app. Neither looked below the app. The child environment itself is
  settled (`RT-child-environment-one-owner`) and is not reopened here.
- open PR: none

**Evidence.**

- `texra/src/utils/git/gitReads.ts:1-5` claims "Every host and tool that
  asks one of these questions asks it here, so a fix (a timeout) is made
  once" (`GIT_READ_TIMEOUT_MS = 10_000`, `:23`). Its consumers are texra
  and the CLI (`cli/src/commands/installGithubAction.ts:16`,
  `texra/src/latex/latexdiff.ts:27`, `tools/github/githubSubscriptionTool.ts:59`,
  `tools/github/plugin.ts:10`, `utils/git/repositoryOverview.ts:22`).
- The harness cannot import it and asks the same questions itself:
  `agent/prompt/workspaceInfo.ts:60-75` runs `rev-parse --is-inside-work-tree`
  and `symbolic-ref --short HEAD` with its own 3 s timeout (`:17`), and its
  comment argues against `isGitRepository()` (`:64-68`), a function in the
  package above it; `controllers/session/appStateStore.ts:161-170` runs
  `rev-parse --path-format=absolute --git-dir --show-toplevel` with a 5 s
  timeout and its own stderr classification (`:172-174`);
  `common/plugins/pluginGit.ts:93` reads `rev-parse HEAD`. Three timeouts
  (3 s, 5 s, 10 s) for the same kind of read.
- "Run git under the machine environment" is hand-written twice, field for
  field: `harness/src/common/plugins/pluginGit.ts:18-53` and
  `texra/src/latex/overleafClone.ts:178-197` both build
  `ChildProcess.make('git', args, { env: makeMachineGitEnv…, extendEnv: false,
  detached: false, forceKillAfter: '5 seconds' })`, drain stderr with
  `Stream.decodeText` + `Stream.mkString`, await `exitCode` under
  `Effect.scoped`, and trim. `makeMachineGitEnv` is on the public `./node`
  entry (`harness/src/node.ts:82`, `harness/docs/api/node.md`) for this
  one external consumer (`overleafClone.ts:20`) and a test
  (`src/test-kernel/cli/OverleafCloneCommand.vitest.ts:7`), and its
  correctness depends on every caller remembering `extendEnv: false`
  (`gitEnv.ts:39-44` says so in prose).
- The CLI keeps a third runner with no timeout (`cli/src/runtime/gitOps.ts:15-23`)
  for one read (`localBranchExists`, `:35-43`) and the action's writes.

**The design decision behind it.** "How TeXRA runs git" was given an owner
in the app layer, but the harness is the lowest layer that runs git, so
the owner cannot serve it, and each harness site writes its own.

**The better design.** One module in the harness,
`harness/src/utils/system/git.ts` (beside `gitEnv.ts`), exported from
`./node`:

- `gitRead(cwd, ...args)`: today's `gitValue` (one timeout, quiet, trimmed,
  null on failure), plus the five named reads `gitReads.ts` has now and
  `gitDirAndTopLevel` for `appStateStore`. `workspaceInfo.getGitInfo` and
  `appStateStore.openRepoStateStore` call them;
  `cli/runtime/gitOps.localBranchExists` becomes one more named read.
- `machineGit(args, { cwd?, env?, input? })`: the one runner that owns
  `extendEnv: false`, the kill grace and the stdout/stderr/exit drain,
  answering `{ stdout, stderr, code }`. `pluginGit.git` maps its result to
  `PluginError`; `overleafClone.runGit` passes its locale and input.

Deleted: `texra/src/utils/git/gitReads.ts` (87 lines, moved),
`pluginGit.git`'s spawn body and `overleafClone.runGit` (about 60 lines),
the `makeMachineGitEnv` export from `./node` (it becomes file-local to
`git.ts`), and the false "every host and tool asks here" claim. Callers
write `yield* currentBranch(root)` from `@texra-ai/harness/node` instead of
`@texra/utils/git/gitReads`.

**What we give up, and risk.** The harness's public `./node` surface gains
the reads (an API report diff) and loses `makeMachineGitEnv`. The prompt's
branch read changes from `symbolic-ref` to `rev-parse --abbrev-ref`; both
answer null on a detached HEAD, but `workspaceInfo` deliberately accepts a
bare repository (`:64-68`), so its `insideWorkTree` gate keeps exit status,
not the `'true'` reading: that is a second named read, not a flag.

**How I tried to refute it.** Looked for a reason the harness must not hold
git reads (it already holds `gitEnv.ts`, `pluginGit.ts` and the
repository-root resolution of `appStateStore`); checked that the two
runners differ only in stdin and stdout handling, which are arguments;
checked that the child environment question is not what this changes
(both runners keep the machine environment, as the refusal requires).

## LI-3: "What a GUI-launched process lacks from the user's shell" is answered three ways in three packages: a hand-written login-shell read, the `fix-path` package, and two PATH lists that overlap

- flags: repetition, information leakage
- package: desktop (`main/platform/pathFix.ts`); cli
  (`runtime/platform/loginShellEnv.ts`, `cliContext.ts`); texra
  (`platform/defaults/commandDirs.ts`)
- kind: refactor
- size: S
- earlier: none (the child-environment refusal `RT-child-environment-one-owner`
  is about which credentials a child keeps, not about recovering the
  login shell's variables)
- open PR: none

**Evidence.**

- The background service recovers the user's environment with a
  hand-written login-shell read: `cli/src/runtime/platform/loginShellEnv.ts:30-120`
  runs `$SHELL -ilc "printf MARKER; env -0"` with a clean environment, a
  10 s timeout, its own process group and a SIGKILL teardown, and
  `adoptLoginShellEnvironment` (`cli/src/runtime/platform/cliContext.ts:585-602`)
  merges it into `process.env`; one caller (`cli/src/commands/service.ts:88`).
  Its header names the problem it solves: "a desktop app opened from the
  Dock has a minimal PATH" (`loginShellEnv.ts:1-7`).
- The desktop main process, which is that Dock-launched app, solves the
  same problem a second way: `desktop/src/main/platform/pathFix.ts:13-20`
  calls the `fix-path` package (`desktop/package.json:43`; version 5 reads
  the login shell's PATH through `shell-path`, synchronously, at startup;
  `node_modules` is not installed in this checkout, so this is from the
  package's documented behaviour, not read) and then prepends its own
  macOS list (`pathFix.ts:3-11`: `/Library/TeX/texbin`,
  `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`,
  `/sbin`). Called once, `desktop/src/main/platform/index.ts:109`.
- Every command the harness runs already gets the app's own list of
  directories "a GUI-launched process may lack on PATH"
  (`texra/src/platform/defaults/commandDirs.ts:1-5`), whose macOS branch
  (`:86-94`) holds `/opt/homebrew/bin`, `/usr/local/bin`,
  `/Library/TeX/texbin` again, plus `/usr/texbin`, MiKTeX and `~/.local/bin`
  that the desktop list lacks. The desktop's own terminal
  (`desktop/src/main/desktopPtyHost.ts:103`) copies `process.env`, so it
  sees the desktop list and not the app's: a `claude` installed in
  `~/.local/bin` resolves for a harness command and not in the desktop's
  terminal when the login profile does not add it.

**The design decision behind it.** "How does a process started outside a
terminal get the user's environment?" was answered where each process
starts, by its author, with whatever was at hand.

**The better design.** One answer, two parts, both in texra's
`platform/defaults/`:

1. `loginShellEnvironment` and `adoptLoginShellEnvironment` move from the
   CLI to beside `commandDirs.ts` (they import only Effect, Node and
   `@texra-ai/harness/schemas`). The service keeps calling it; the desktop
   main process calls it in its startup program in place of
   `repairLaunchPath()` (it is already inside `Effect.gen` there,
   `index.ts:108`, with the spawner in context).
2. No second directory list: what the login shell does not provide,
   `withCommandDirs` adds for every command, and the desktop terminal's
   environment is built with the same `withCommandDirs`
   (`@texra-ai/harness/node`) instead of a raw `process.env` copy.

Deleted: `desktop/src/main/platform/pathFix.ts` (20 lines,
`MACOS_PATH_ENTRIES`), the `fix-path` dependency, and the CLI's ownership of
a module two hosts use.

**What we give up, and risk.** `fix-path` runs synchronously before the
window opens; the Effect read is asynchronous and bounded at 10 s, so the
desktop's first spawned command must come after it (it does: the call sits
at the head of `initialize`, before any root opens). The CLI's read adopts
every login variable, where `fix-path` took only PATH; on the desktop that
is the behaviour the service already has, so a window and its service see
the same environment.

**How I tried to refute it.** Checked whether the two reads differ in a way
that matters: both run the login shell interactively (`-ilc`) and both read
its environment; the CLI's isolates the shell in its own process group so a
terminal is not stolen, which the desktop needs less but does not mind.
Checked that the VS Code extension needs neither (VS Code resolves the
shell environment for the extension host itself), so two callers, not one,
justify moving the module.

## LI-4 (batched): Three smaller facts restated across a package boundary instead of read from their owner

- flags: repetition, information leakage, comment restates code (one false
  comment)
- package: harness (a, b); texra (b, c); cli (c)
- kind: refactor, with one false comment (a)
- size: S
- earlier: none for these three; (c) sits beside landed note item 4
  (`2026-11-15-host-rules-and-app-facts-with-two-owners.md`, the coding
  plan's `credentialName`), which removed columns restating the API
  provider, not this one
- open PR: #14949 rewrites `codingPlans.ts` (`a183465f88`, one id per plan)
  and leaves `preferenceLabel` as it is

**(a) The providers' names, spelled again for the endpoint rows, under a
false reason.** `harness/src/shared/state/providerSettings.ts:41-52` passes
a display name with each id to `endpointRow` (`:25-33`), which uses it only
in the row's `title` and `description`: `'OpenAI'`, `'Anthropic'`, …,
`'Qwen'`, `'MiniMax'`, `'GLM'`, `'Meta'`, the ten names of llm's `MANIFEST`
(`llm/src/providers/providerPlugins.ts:67-140`, read by
`providerDisplayName`, `providers.ts:15-17`). The ids are compile-checked
against llm (`harness/src/model/modelSettings.ts:62-82`); the names are not.
The file header gives the reason: "No import of the llm catalog: the
settings catalog is reachable from stored shapes, which the llm package may
not own" (`providerSettings.ts:9-11`). It is false: eight modules in
`harness/src/shared/` import `@texra-ai/llm` today, among them
`shared/schemas/errors.ts:3-7`, which imports `providerDisplayName` and
`PLAN_ROUTES` for a stored shape's message, and the settings webview
imports `providerDisplayName` from the llm entry
(`extension/src/settingsView/frontend/components/profile/ModelSelectionList.ts:8`),
so the entry is browser-safe. Fix: `endpointRow(id)` reads
`providerDisplayName(id)`; the ten literals and the false paragraph go.

**(b) "The task ended before this tool completed." twice.**
`harness/src/transcript/completedRunArchive.ts:26` (`CUT_BY_RUN_END_RESULT`,
the text a model reading the run through `executions`, and an export, gets
for a call the run's end cut short) and
`texra/src/ui/copy/scriptStage.ts:21-23` (`TOOL_CUT_BY_RUN_END_NOTE`, the
same call's card error in the progress view and the terminal,
`cli/src/chat/tui/panes/toolRenderers.tsx:163`,
`texra/src/ui/progress/formatters/logFormatters/toolFormatters.ts:24`).
Both describe `ToolRow.cutByRunEnd`, which the harness defines
(`shared/transcript/transcriptRow.ts:162`). Fix: the harness exports the one
sentence beside the row field from `./transcript` (which `scriptStage.ts`
already imports from); the app constant goes. A reader then sees the same
words as the model it asks about the run.

**(c) A coding plan's switch label restates the harness row's title.**
`texra/src/shared/model/codingPlans.ts:37,48` (`preferenceLabel: 'Kimi
Code subscription'`, `'GLM Coding Plan'`) are the `title`s of
`KIMI_CODE_PREFER_SETTING` and `GLM_CODING_PLAN_SETTING`
(`harness/src/shared/state/stateSettings.ts:484,493`), the rows the label
names; `/config` shows the row's title, and the CLI's tip says so ("the
same name `/config` and `/login` show",
`cli/src/chat/tui/commands/handlers/modelAccessCommands.ts:33-35`) and then
spells the Kimi label a third time as a literal (`:36`). Fix: the plan
carries its switch row (`preference: KIMI_CODE_PREFER_SETTING`) and every
reader (`modelAccessRoute.ts:138`, `modelAccessSelection.ts:185-216`,
`ui/copy/modelAccess.ts:49,54`, the tip) reads `plan.preference.title`; the
column and the literal go.

**What we give up, and risk.** None of the three changes a stored value.
(b) changes no wording. (a) and (c) make a renamed provider or row rename
its label everywhere, which is the point.

**How I tried to refute it.** (a): looked for a bundle that loads
`providerSettings.ts` without llm (the settings webview loads both). (b):
checked whether the model-facing and person-facing sentences are meant to
differ (they are identical and describe one field). (c): checked that the
GLM row's title is the label shown for the switch (`/config` renders rows
by `title`).

## LI-5: A settings page's icon is written once per host, though the command already names its page

- flags: repetition, information leakage
- package: desktop (`shared/desktopCommandSurface.ts`); extension
  (`settingsView/frontend/settingsNav.ts`); texra
  (`shared/settingsView/settingsTarget.ts`, `shared/commands/catalog.ts`)
- kind: refactor
- size: S
- earlier: none; the catalog's `settingsTab` column
  (`texra/src/shared/commands/catalog.ts:17-24`) was introduced so that
  "both hosts derive their `showSettings` handler rows … instead of
  hand-mirroring the tab per host", and stopped at the handler
- open PR: none

**Evidence.** The six settings pages have their Web Awesome icon, label and
group in `SETTINGS_TAB_METADATA`
(`extension/src/settingsView/frontend/settingsNav.ts:36-104`: models
`server`, agents `robot`, plugins `cube`, memory `database`, general `gear`).
The desktop menu writes the same icons again for the commands that open
those pages (`desktop/src/shared/desktopCommandSurface.ts:95-111`:
`'texra.showModels': 'server'`, `'texra.showAgents': 'robot'`,
`'texra.showTools': 'cube'`, `'texra.showMemory': 'database'`,
`'texra.showDashboard': 'gear'`), while the page each command opens is
already data (`settingsTabByCommand`, `catalog.ts:350`, read by the same
desktop file at `:198-200`). They agree today because two people kept them
so. The page metadata lives in the extension package although the desktop
renderer mounts the same settings frontend
(`desktop/src/renderer/settingsDialog.ts:4`) and the page list it labels is
texra's (`settingsTarget.ts:15-22,34-41`).

**The design decision behind it.** "What does a settings page look like in
a menu?" is answered by each host's menu, beside the one place that
already says which page a command opens.

**The better design.** The page metadata (icon, label, group, description,
section labels) moves from `settingsNav.ts` to beside
`SETTINGS_PAGE_SECTIONS` in `texra/src/shared/settingsView/settingsTarget.ts`,
keyed by the same `SettingsTabPanelName`. `DESKTOP_COMMAND_ICONS` keeps only
the desktop-local commands and `texra.showMainView`; a settings command's
icon is its page's (`settingsTabByCommand[id]`, page part). The page labels
are then the ones LI-1 step 2 needs to word a location. Deleted: five icon
rows in desktop; `settingsNav.ts` keeps only its mapping into nav entries.

**What we give up, and risk.** `texra.showGitSettings` opens a section
(`general/git`) and keeps its own `code-branch`, since sections have no
icon; that stays one explicit row. No behaviour changes.

**How I tried to refute it.** Checked whether the desktop's icons are meant
to differ from the nav's (all five are identical) and whether the VS Code
codicons in the catalog (`$(extensions)`, `$(gear)`) could serve (they are
a different icon set for VS Code's own menus, so they stay).

## Good modules in this area

- `harness/src/logger/redaction.ts:25-37`: `PROVIDER_KEY_PATTERNS_BY_PROVIDER`
  `satisfies Record<ApiKeyProviderId, …>`, so a provider llm adds cannot
  ship with its keys unredacted. The pattern for any harness table keyed by
  an llm vocabulary.
- `llm/src/providers/providers.ts:15-46`: `providerDisplayName`,
  `apiKeyEnvName` and `API_KEY_ENV_NAMES` derived from the manifest; every
  package that names a provider or its variable reads them (LI-4 (a) is the
  one exception found).
- `texra/src/shared/commands/catalog.ts:17-24,350`: `settingsTabByCommand`,
  one column both hosts' handler maps derive from (LI-5 extends it to the
  icon).
- `harness/src/shared/state/providerSettings.ts` with the `AssertNever`
  gates in `harness/src/model/modelSettings.ts:56-82`: the harness may keep
  its own rows over llm's catalog, and a missing or extra provider fails to
  compile.
- `texra/src/ui/copy/scriptStage.ts`, `ui/copy/runStatus.ts`: one copy
  record read by the progress view, the terminal and `texra run`'s plain
  output; the CLI paints from them instead of restating words.

## Already settled, left alone

- The environment a child process starts from (`inheritedEnv`,
  `makeMachineGitEnv`, the MCP server's): `RT-child-environment-one-owner`
  in `refuted-candidates.json`. LI-2 keeps the machine environment and only
  removes the second runner.
- The harness's own wording of a used-up plan and an unavailable
  subscription beside the app's (`harness/src/shared/schemas/errors.ts:93-125`,
  `texra/src/ui/copy/modelAccess.ts:107-123`): kept with reasons in
  `.agents/docs/proposed/simplification/2026-11-03-storage-errors-and-stop-paths.md`
  ("Done 2026-11-06": stored on the run's rows, read by an embedder and a
  child's parent).
- The subscription and plan route literals in the harness
  (`shared/schemas/usage.ts:14-19`, `shared/model/subscriptionAuth.ts:19-20`):
  storage's spelling of llm's `PLAN_ROUTES`, converted both ways by the
  route decision so a missing member fails to compile (`usage.ts:6-12`).
- The `\criticize` scale in the extension's parser and severity mapping
  beside the diagnostics tool's schema in texra: round 3 T4 (keep the
  parser's range check as the boundary) and round 4 R12 (one comment in
  each naming `criticize.tex`).
- `GenericDiagnostic`'s severity in VS Code's numbering
  (`texra/src/utils/diagnostics/diagnosticFormatting.ts:11-14`): the
  extension hands `vscode.Diagnostic[]` to the port unchanged
  (`extension/src/frontend/latex/linter.ts`, `getLinterMessages`), so the
  shape is the boundary's; the type-versus-schema half is TC-11 (e).
- Reaching the bundled service (`ELECTRON_RUN_AS_NODE` in
  `extensionService.ts:31`, `desktopService.ts:50`): open item 6 of
  `2026-11-15-host-rules-and-app-facts-with-two-owners.md`.
- The CLI's cheap-start model beside the GUI's default
  (`cli/src/runtime/platform/cliConfig.ts:33-43`,
  `texra/src/model/curatedModels.ts:12`): a documented, deliberate
  difference; CL-8 covers where the CLI resolves it.
- The usage log's wire schema in the harness beside the edge function:
  round 7 W2.
- Remainder of L2-7.7 (landed, `TEXRA_SITE_URL`): the desktop navigation
  policy still allows the site by the literal host
  (`desktop/src/main/desktopNavigationPolicy.ts:14-16`, `'texra.ai'`), the
  site the lens-2 row said a domain change would break. One line:
  `new URL(TEXRA_SITE_URL).hostname`. Too small for its own finding; left
  for the desktop owner's PR.

Dropped on verification: 19 candidates, among them the image MIME tables in
llm and the clipboard paste (two facts), the Retry-After readers (a GitHub
rate limit is not a provider retry), the history query's `runs.status`
words beside the UI's status keys (a SQL column for the model, not a
label), the CLI's credential-prefix check beside the redactor (no input
reaches a wrong answer: an unmatched prefix is redacted by the remainder
rule), the three host sign-in presenters and export dialogs (per-host
presentation over one controller), the CSP strings (two documents with
different needs), and an identical five-line `envVar` in llm and the
harness (llm cannot import the harness; not worth an export).
