# P. Settings, shared schemas and the model layer: design red flags

Read on `main` at `4e32bb921018ccb4626c0fb47b25a2c2d365b5f4` (R6, #14789, is
HEAD). No open PR touches this area: the two open ones, 14773 (docs) and
14741 (the store's blob links), change none of its files (checked with
`gh api repos/LionSR/TeXRA/pulls/<n>/files`).

Scope: `packages/harness/src/shared/schemas/` other than the row kinds
(`sessionEvent`, `runHistoryEvent`, `rowVersions`, `run`, `runRecords`,
`storedTurn`, `followUp`, `sessionViewInput`, `request`, `traceEvent`, which
are C's, B's and R7's), `shared/config/`, `shared/state/`, `shared/model/`,
`shared/constants/`, `packages/harness/src/model/`, and TeXRA's
`shared/settingsView/texraSettings.ts` and `settingSurfaces.ts`. Paths are
repo-relative. Counts are over `packages/*/src` unless marked; tests are
`src/test-kernel` and `packages/*/test`.

Already found, not repeated: `MODEL_PROVIDERS`, `PROVIDER_ENDPOINT_STATE_ENTRIES`
and the "add a provider" count (O9a); the subscription provider's spellings
(`chatgpt | grok` beside the plan routes) and the account port (O3); the
`AgentConfigSchema` defaults behind the launch pre-check (G11d); the settings
view's sixteen pushed message kinds and its repaint wiring (J5, G8, lane
3.4); `ProviderErrorClassification` (D2/R9); the transport knobs
`model.useGoogleBackgroundResponses`, `model.openaiFastTier`,
`model.useGoogleInteractionsServerState`
(`2026-11-03-fewer-processing-options.md` §1). Where a finding borders one
of these, it says so.

## Numbers

Lines: `shared/schemas/` 5 599 in 45 files, of which the row kinds above are
2 446 and this area 3 153 in 35; `shared/state/` 900 (3 files);
`shared/config/` 404 (1); `model/` 1 244 (5); `shared/model/` 19,
`shared/constants/` 46; `texraSettings.ts` 383 and `settingSurfaces.ts` 219.

Five largest files: `shared/state/stateSettings.ts` 695,
`model/computeModelOptions.ts` 597, `shared/config/settings.ts` 404,
`texraSettings.ts` 383, `model/modelSettings.ts` 297.

Comment-line share (`grep -cE '^\s*(/\*|\*|//)'` / total), files ≥ 200
lines: `settings.ts` 40 %, `shared/schemas/toolResult.ts` 35 %,
`computeModelOptions.ts` 25 %, `shared/schemas/prompts.ts` 24 %,
`settingSurfaces.ts` 23 % (`stateSettings.ts` 22 %, `texraSettings.ts` 18 %,
`modelSettings.ts` 17 %). `settings.ts`'s share is mostly the casts and the
sync-read ruling explained; `computeModelOptions.ts`'s narrates its four
stages (good; see "Good modules").

Primitives in the area: `*Unsafe(`, `uninterruptible`, `addObserver`,
`Effect.never`, module-level `let`: 0 each. This area is data and schemas,
not fibers; its red flags are representations. `throw new` 9 (three in
`settingsCatalog`, three in `placeRows`, `entryOf`, one invariant in
`resolveModelAvailability`, one corrupt-blob read); `Effect.try` 1
(`subscriptionOn`, a read that cannot throw); `Result.try` 1
(`chooseOnRoute`); `withDecodingDefault` 65; `catchDecoding` 0.

The setting reads the area's API invites: 81 `Settings.get|inspect|getConfig|defaultOf`
reads, of which 79 name the value type at the call (`Settings.get<boolean>(…)`)
in 52 files (harness 32, texra 36, cli 9, extension 2); 15 more
`settingSignal<T>(key)` in the settings webview.

## The key questions, answered

**How the catalog is built.** The harness declares its rows in
`stateSettings.ts` (17 config-file rows in `HARNESS_CONFIG_ROWS`, `:144-329`,
the approval policy, `:351-368`, and 25 state rows, `:393-599`);
`settingsCatalog({ namespace, rows, defaults })` (`:636-695`) puts the
app's rows after them, refuses a duplicate key, and folds the app's defaults
into harness rows' schemas. TeXRA's rows are `texraSettings.ts:105-267`, its
plugins' in `documentsSettings.ts` and `integrationSettings.ts`.
Where a row shows is the app's: TeXRA rows carry `surfaces` inline, harness
rows get theirs from `HARNESS_ROW_SURFACES` keyed by string
(`settingSurfaces.ts:122-219`), joined at module load by `placeRows`
(`texraSettings.ts:294-326`), which throws on three mismatches. This is the
design #14467 landed (the release PRD's lane 7, slice 4). Findings 3–5 are
about what that join still leaves: rows addressed by string, a second
read path for state, and "is it shown" inferred from optional copy.

**Which schemas restate each other.** Usage (finding 6:
`RunUsageTotalsSchema` restates `TokenUsageStatsSchema` under `total*`
names); the bounded-setting constants and the rows built from them
(finding 3); two catalog rows and the schemas their readers pass again
(finding 4); `BaseProposalFieldsSchema` and `AgentConfigObjectSchema`
(batched, 7a).

**Do capability and price tables duplicate llm-zoo?** No. `model/` holds no
price, window or capability table: it reads `MODEL_CONFIGS`, `selectModel`,
`decideModelRoute` and `routeConfig` from `@texra-ai/llm`
(`computeModelOptions.ts:3-19`), and `turnCost` in llm owns the arithmetic.
What restates llm-zoo is prose and one constant (batched, 7c): the Codex
window copy and `max: 872` in `CHATGPT_CODEX_CONTEXT_WINDOW_SETTING`, and
the region toggles' endpoint hosts. `DEFAULT_MODELS` is a curated choice,
documented as such and failed by a test on an llm-zoo bump
(`shared/constants/defaultModels.ts:18-24`).

**How the config providers fit together.** One class, `JsonConfigProvider`
(`platform/defaults/jsonConfigProvider.ts:62-136`), over three
`ConfigStore`s (project, user, local); `MemoryConfigProvider` is the same
class over in-memory stores (`memoryConfigProvider.ts:35-44`), not a
second rule. The scope rule is `projectValueIgnored` (`:47-53`), shared by
reads and the open-time warning (`packages/texra/src/platform/defaults/nodeStores.ts:100-106`).
`Settings` (`shared/config/settings.ts`) is the checked read over it. Two
things break that picture: the CLI wraps the stores so an invalid value
reads differently there (finding 1), and `Settings` restates the scope
rule for one kind of row (finding 2).

---

## Finding 1. What an invalid stored value reads as is decided by five readers, and on the CLI a malformed telemetry opt-out reads as consent

**Red flags:** error handling that should be defined out of existence (each
reader picks its own fallback); two representations of one rule that
disagree across hosts; a false comment. **This one changes behaviour:** it is
a latent defect in a privacy row and goes first (order note, rule 1).

**Evidence.** A config value its row rejects reads five ways:

1. `Settings.get` / `getConfig` / `state`: warn, then the row's default. The
   lower tiers are never consulted: a bad project value hides a good user
   value (`settings.ts:199-209`, `:304-313`, `:384-393`).
2. `Settings.inspect`: `invalid` with the cause, no substitute
   (`settings.ts:280-295`); one caller, the kill-policy gate
   (`packages/harness/src/tools/executions/killPolicy.ts:28`).
3. The CLI's provider: `withoutInvalid` drops the value at its tier, so the
   read falls through to the next tier or the default
   (`packages/cli/src/runtime/cliConfig.ts:270-292`), warned once at startup
   (`:195-237`: "every read passes over it to the next tier"). This is the
   CLI's one provider for the whole process
   (`cliContext.ts:91-95`, `initPlatform.ts:308-317`). The extension and the
   desktop open the same files without it
   (`packages/extension/src/extension.ts:198`,
   `packages/desktop/src/main/platform/index.ts:74`, both
   `openTexraConfigStores`, `nodeStores.ts:118-155`).
4. Telemetry: `config.get<unknown>` and `typeof value === 'boolean'`, else
   warn and `false` (`packages/texra/src/telemetry/UsageLogService.ts:129-136`:
   "a mistyped `"false"` must not read as consent").
5. `read_config`: the raw value, shown on purpose
   (`packages/texra/src/tools/setup/ConfigTools.ts:78-83`).

On the CLI, readers 1 and 4 run over reader 3's provider. So for a project
file holding `"texra.telemetry.enabled": "false"` (a string), VS Code and
the desktop read `"false"`, fail the `typeof` check and stop reporting; the
CLI's wrapper drops the value, `projectValueIgnored(row, undefined)` lets
the empty project tier through (`jsonConfigProvider.ts:51-52`), and the read
returns the user file's value or the row default, `true`
(`texraSettings.ts:209-212`). The row's own contract says the opposite: "A
malformed project value counts too, and fails closed"
(`stateSettings.ts:91-96`). The same divergence on a permission row: a
local `"texra.approvalPolicy": "nevr"` over a user `"yolo"` reads `ask` (the
default, `shared/approvalPolicy.ts:23`) in VS Code and `yolo` on the CLI.
The only CLI test of the project telemetry value uses a real `false`
(`src/test-kernel/cli/CliContext.vitest.ts:64-84`).

**The design decision behind it.** "What does a value the row rejects mean?"
is answered by whoever reads, not by the read. `Settings` already owns the
answer for every row (default after a warning) and for gates (`inspect`);
the CLI added a third at the store layer to avoid repeated warnings, and
telemetry kept a hand check because `Settings` could not read its merged
value (finding 2).

**The better design.** One rule, the one `Settings` and two of the three
hosts already apply.

- Step 0 (the fix): delete `withoutInvalid`; the CLI's provider is the
  plain `JsonConfigProvider` the other hosts use, and its startup warning
  says the value "reads as its default" instead of "passes to the next
  tier" (`cliConfig.ts:197-199`, `:270-273`). One regression test, written
  to fail first: a CLI context over a project file with a string
  `"false"` reads telemetry as off.
- Then, with finding 2: telemetry reads through `Settings.inspect`
  (`invalid` → `false`), and the hand check at `UsageLogService.ts:129-136`
  goes.

Deleted: `withoutInvalid` and its comment (`cliConfig.ts:270-286`, 1 use),
the telemetry hand check. Afterwards a reader picks between two readings
of one module: `Settings.get` (default after a warning) and `Settings.inspect`
(fail closed), plus `read_config`'s display.

Considered and rejected: moving the CLI's pass-over rule into
`JsonConfigProvider` for every host. It makes an invalid value of a
permission or privacy row fall to a looser tier, which is this defect's
shape; it would need the telemetry row to say "any present value but `true`
is off" in its schema to stay closed.

**What we give up.** On the CLI, a malformed project value no longer lets
the user file's value through; it reads as the row default, as it already
does in the other two hosts. `Settings.getConfig`'s per-read warning
(`settings.ts:311`) then repeats for each read of a bad value; the CLI's
startup report already names it once.

**Change amplification.** "A new privacy or permission row that must fail
closed": today the row, a hand check in its reader, and a check that the
CLI wrapper does not undo it (3 places, the last unenforced); after, the
row and `Settings.inspect` at its reader (2).

**Depends on:** none. The structural half lands with finding 2.

---

## Finding 2. The scope rule is written twice, and the settings view and the runtime disagree on the one row where the two differ

**Red flags:** two representations of one fact; information leakage (the
config provider's tier rule restated in `Settings`); a false comment.

**Evidence.** `projectValueIgnored` (`jsonConfigProvider.ts:47-53`) decides
which tiers answer for every key, and `JsonConfigProvider.get` applies it
(`:84-100`): for a `global` row the project value is skipped, unless the row
is `projectMayOptOut` (telemetry), whose project value counts unless it is
`true`. `Settings` then decides again: `rawConfigValue` reads a `global`
row through `config.inspect(key).globalValue` and everything else through
`config.get` (`settings.ts:211-223`), justified by "a global-target row read
through the merged `get()` could report a workspace value the settings view
can never write". Since `projectValueIgnored` landed that is false for every
`global` row but telemetry, where the two now disagree:

- the runtime reads the merged value (`UsageLogService.ts:132`,
  `config.get`), so a project's `false` stops reporting;
- the settings view's Privacy toggle reads the snapshot
  (`packages/extension/src/settingsView/frontend/tabs/PrivacyTab.ts:39`),
  built by `Settings.get` (`packages/texra/src/shared/settingsView/handlers/settingsSnapshot.ts:26-30`),
  which reads the user value only and shows "on".

The harness guide states the exception in prose (`packages/harness/AGENTS.md`
"Configuration, storage, and workspace files": "The exception is
`texra.telemetry.enabled`, read from the merged config").

**The design decision behind it.** "Which tier answers this key?" belongs to
the provider, which holds the tiers. `Settings` re-asked it before the
provider had the rule and kept its copy after.

**The better design.** `Settings` reads every config row through
`config.get` and states no tier rule; `rawConfigValue`'s branch and its
comment go. Telemetry then reads the same value everywhere, which lets
finding 1 move it onto `Settings.inspect`, and the guide's exception
sentence goes. Deleted: `rawConfigValue` (1 function, 2 callers in
`settings.ts`), the guide's exception sentence. `ConfigInspection` keeps its
two other readers (`model/subscriptionAccess.ts:54`,
`packages/cli/src/runtime/cliConfig.ts:148,176`).

**What we give up.** With a project opting out, the Privacy toggle shows
"off", and switching it on writes the user file without changing the read.
The view should then show the toggle disabled with "this project opts out";
that is a UI line, and it is honest where today's toggle is not.

**Change amplification.** "A second `projectMayOptOut` row": today the row,
a merged reader that bypasses `Settings`, and a guide exception (3); after,
the row (1).

**Depends on:** none; one PR with finding 1.

---

## Finding 3. A setting is addressed by a string and typed by its caller

**Red flags:** information leakage (a row's key and value type known by
every reader); two representations of one fact (a row's bounds as plain
data and as its schema); change amplification; unknown unknowns (a wrong key
throws at the first read, a wrong type never fails).

**Evidence.**

- `Settings.get<T>(stores, key: string)` looks the row up by string and
  casts (`settings.ts:269-278`, cast at `:274`); an unknown key throws at
  the first read (`entryOf`, `:164-170`). 79 of 81 reads name `T`
  themselves, in 52 files; the settings webview adds 15
  `settingSignal<T>(key)` and 24 `renderStateSetting*Row(key)`, each of
  which throws at render for a key with no settings-view row
  (`packages/extension/src/settingsView/frontend/components/shared/stateSettingRows.ts:57-60,68-76`).
  A plugin names its injection gate the same way:
  `Plugin.injectedWhen?: Record<string, string | true>`
  (`packages/harness/src/tools/plugins.ts:128`), read as
  `Settings.get<boolean>(roots, setting)`
  (`packages/harness/src/agent/runtime/agentToolResolution.ts:122`).
- A key has many homes. Constants: six `*_SETTING` objects and two key
  constants (`shared/schemas/coreSettings.ts:10-119`); `AGENT_SKILLS_CONFIG_KEY`
  with its default and schema (`shared/schemas/agentSkills.ts:6-10`);
  `APPROVAL_POLICY_CONFIG_KEY` (`shared/approvalPolicy.ts:34`);
  `WorkspaceStateKey` (9) and `GlobalStateKey` (15)
  (`shared/state/stateKeys.ts:14-78`); `TexraStateKey` (4) and
  `TELEMETRY_ENABLED_KEY` (`texraSettings.ts:51-64`); `DocumentsStateKey` (8);
  `CodexStateKey`, `ClaudeAgentStateKey` (2 each); `ZOTERO_PORT_KEY`
  (`packages/texra/src/tools/zotero/bbtClient.ts:41`); `PREFER_SUBSCRIPTION_KEYS`
  (`model/subscriptionAccess.ts:19-24`); the setup tool's
  `UPDATABLE_KEY_LIST`, namespaced (`ConfigTools.ts:33-40`). Bare literals:
  `'model.openaiFastTier'` and `'model.useGoogleInteractionsServerState'`
  in 3 files each (`stateSettings.ts`, `modelSettings.ts`,
  `settingSurfaces.ts`), `'chatgptCodex.preferSubscription'` and
  `'xaiGrok.preferSubscription'` in 2 (`stateSettings.ts:259,278`,
  `subscriptionAccess.ts:22-23`), `'glm.useChina'` and `'bib.defaultPath'`
  in 3, seven more in 2.
- The bounded rows state their bounds twice. `MODEL_RETRY_MAX_ATTEMPTS_SETTING`
  and five siblings hold `defaultValue`, `min`, `max` as data "so the two
  cannot disagree" (`coreSettings.ts:23-27`); the row rebuilds them into a
  schema (`stateSettings.ts:148-163, 245-258`), and the settings view
  re-imports the numbers for its widget
  (`packages/extension/src/settingsView/frontend/tabs/AgentsTab.ts:247-273`,
  `ApprovalTab.ts:99-100`). Outside the row and the widget, `min`/`max` have
  no reader; `defaultValue` is read only by tests (6 sites) and `.auto`/`.max`
  by `childRunBudget.ts:40-44`. The six come in three shapes: with
  `configKey`, without it beside a separate `*_CONFIG_KEY`
  (`CHILD_RUN_CONCURRENCY_BUDGET_*`), and as three loose exports
  (`agentSkills.ts`). TeXRA repeats the pattern with `LATEX_CONFIG_DEFAULTS`
  and `LATEX_CONFIG_RANGES` (`documentsSettings.ts:12-16, 52-61`).
- The 2026-10-27 target designs named "key constants restate their rows'
  keys" as a dual system (§5); its slice V1 deleted `configKeys.ts` and the
  namespace prefix but left the constants.

**The design decision behind it.** "What identifies a setting?" The answer
today is its key string, so the type, the slot, the bounds and the default
travel separately and each reader restates the one it needs. The row
already holds all of them.

**The better design.** The row is the handle. A row is a value
`SettingRow<A>` with `schema: Schema.Codec<A, unknown>` (an object literal
`satisfies SettingRow<number>`; no builder). `Codec` is covariant in its
type (`Schema.d.ts:856`, `out T`), so a `SettingRow<number>` is still a
member of the catalog's `readonly StateSettingEntry[]`, and
`StateSettingEntry` becomes `SettingRow<unknown>`. `Settings.get<A>(stores,
row: SettingRow<A>): Effect<A, StateReadFailed>` looks up the catalog's
effective row by `row.key` (so an app default still applies) and casts once,
inside `Settings`, where it is true by construction; a generic UI passes the
entry it iterates and gets `unknown`, as today. Bounds are written once in
the schema (`Schema.isBetween`, `Schema.d.ts:6117`); the number widget reads
them back from `Schema.toJsonSchemaDocument(row.schema)` (`:12272`;
`isBetween` emits `minimum`/`maximum`, `Schema.js:4572-4573`).
`HARNESS_ROW_SURFACES` and `injectedWhen` take rows, not strings.

Deleted: the six `*_SETTING` objects and `CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY`,
`DEBUG_MODE_KEY`, `AGENT_SKILLS_CONFIG_KEY`/`_ENABLED_DEFAULT` (and
`coreSettings.ts` with them), the members of `GlobalStateKey`,
`WorkspaceStateKey`, `TexraStateKey`, `DocumentsStateKey`, `CodexStateKey`,
`ClaudeAgentStateKey` that name rows (finding 4 takes the rest),
`PREFER_SUBSCRIPTION_KEYS`, `ZOTERO_PORT_KEY`, `TELEMETRY_ENABLED_KEY`, the
79 + 15 call-site type arguments, and `entryOf`'s throw for harness rows
(every catalog holds them). What remains keyed by string is what is keyed
by string by nature: a stored key read back from a file (`byStoredKey`,
`cliConfig.ts:215`, `ConfigTools.ts:48`) and the webview's wire key.

**What we give up.** A one-line read by a string a person can grep for;
the grep becomes "find references" on the row. The `./schemas` surface
swaps the key and bounds constants for the row values (the API
reports regenerate). This is not `EFF-ADOPT-config-provider`
(`.agents/docs/refuted-candidates.json`): no `Config<T>`, no second schema,
reads stay synchronous where they are; the row that already exists becomes
the key.

**Change amplification.** "Change a row's value type" (a boolean becomes a
three-way literal): today 0 compile errors and every `Settings.get<boolean>`
reader keeps compiling while reading a string as truthy (for
`WorkspaceStateKey.GIT_WORKTREE_SUPPORT`: 2 harness readers and a toggle);
after, a compile error at each reader. "Add a bounded number setting the
harness reads and the settings view shows": today `coreSettings.ts`,
`stateSettings.ts`, `settingSurfaces.ts`, the reader, the tab, `schemas.ts`
(6 files, plus 2 generated API files); after, the same minus
`coreSettings.ts` (5), with the key, type and bounds stated once.

**Depends on:** none. Finding 4 builds on it.

---

## Finding 4. A stored key has two read paths, two rows are read around the catalog, and `WorkspaceStateKey` names the wrong store for eight of its nine keys

**Red flags:** vague and false names; two representations of one fact (a
row's schema and default restated at its reader); a dead declaration.

**Evidence.**

- Catalog rows are read by key (finding 3); every other state key through
  `Settings.state(store, key, schema)`, which takes the schema at each call
  (`settings.ts:376-393`; 9 call sites in 7 files). Two keys are both:
  `WORKSPACE_AGENTS` and `HIDDEN_CUSTOM_AGENTS` are catalog rows
  (`stateSettings.ts:445-458`, with their schemas and defaults) whose only
  readers pass the same schema and default again through `Settings.state`
  (`packages/harness/src/agent/workspaceAgents/workspaceAgentsState.ts:56-63,67-69,95-99`).
  No `Settings.get`, `Settings.set`, catalog-driven UI or `cliRows` entry
  reads either row (`grep WORKSPACE_AGENTS|HIDDEN_CUSTOM_AGENTS`: 2 + 5 sites,
  none through the catalog); the row's comment says as much (`:443-444`).
- `WorkspaceStateKey` is documented as "the harness's workspace-scoped
  state keys (`roots.workspaceState`)" (`stateKeys.ts:13`). Its nine
  members' rows put six in `repoState` (the four `GIT_*`,
  `stateSettings.ts:396-439`, and the two above), two in `config`
  (`DISABLED_SKILLS`, `DISABLED_SKILL_SOURCES`, `:566-585`), and one in
  `workspaceState` (`TOOL_PATH_PROTECTION_ENABLED`, `:586-598`).
- `GlobalStateKey` mixes eight catalog rows with seven non-row keys
  (`MODEL_SELECTION`, `REASONING_LEVELS`, `CUSTOM_AGENT_DIR`,
  `DISABLED_TOOLS`, `MCP_REVISION_KEY`, `INSTALLED_PLUGINS`,
  `ACTIVE_TEAM_ID`, `stateKeys.ts:50-77`), each non-row key decoded by a
  schema at its reader (`model/reasoningLevel.ts:34-40`,
  `agent/index/AgentDirectoryService.ts:41-45`,
  `WorkspaceAgentsController.ts:30,85`, `stateKeys.ts:93-114`,
  `computeModelOptions.ts:309-334`).

**The design decision behind it.** "Where does a key live, and what does it
decode to?" The slot is a row field, the schema is a row field for rows and
a call argument for the rest, and the key tables group by a slot they do
not hold.

**The better design.** One typed key for every stored key: `StateKey<A> =
{ key, slot, schema: Schema.Codec<A, unknown> }`, and a catalog row is a
`StateKey<A>` with copy (finding 5). `Settings.state(store, key: StateKey<A>)`
takes the key alone; `Settings.get` takes either. The seven non-row keys
become `StateKey` values beside their one owner (the model selection beside
`computeModelOptions.ts`, the team beside `WorkspaceAgentsController.ts`, …),
and the two dead rows become `StateKey`s read by their owner. The key
tables go: rows are named in finding 3, the rest here.

Deleted: `WorkspaceStateKey` and `GlobalStateKey` (24 members; 121
references in 42 production files), the two catalog rows, `Settings.state`'s `schema` parameter
(9 sites), the readers' local schema constants (`HiddenKeysSchema`,
`TeamIdSchema`, the inline `Schema.Record(…)` in `reasoningLevel.ts`).

**What we give up.** A single file that lists every harness key; the
catalog lists the rows, and a `StateKey` is found beside its owner. The
stored key strings do not change (`.agents/docs/proposed/architecture/2026-10-27-tech-debt-target-designs.md`
§5: renaming a stored key resets a user's value).

**Change amplification.** "Move a toggle from `workspaceState` to
`repoState`": today the row, and the reader's mental model fed by a key
table that already says the wrong store; after, the row (1).

**Depends on:** finding 3.

---

## Finding 5. A row's copy is optional, and "is it shown" is inferred from which copy fields are set; the copy is checked three ways at three times

**Red flags:** state machine in optional fields; two representations of
one fact; special and general code mixed (one UI's grouping vocabulary on
the harness row).

**Evidence.**

- `StateSettingEntry` makes `title`, `description` and `category` optional
  (`stateSettings.ts:81-86`, "Grouping label for settings UIs. Required once
  a UI renders the row"); `TexraSettingRow` makes `description` and
  `category` required but not `title` (`settingSurfaces.ts:66-77`).
- `placeRows` infers "this harness row must be shown" from
  `description !== undefined && category !== undefined` and throws when no
  placement exists; it throws when a placed row lacks either
  (`texraSettings.ts:299-312`). A placed row without a `title` passes, and
  throws later, when a tab renders it (`stateSettingRows.ts:68-76`). So a
  described harness row has a `category` exactly when it has a placement:
  of the 17 config-file rows, the 8 with a `category` are the 8 placed and
  the 9 without are unplaced (`stateSettings.ts:144-329` against
  `settingSurfaces.ts:124-151`). `category` and the placement are one fact
  stated twice, kept in step by a startup throw.
- The harness reads none of `title`, `category`, `enumLabels`,
  `enumDescriptions` (grep over `packages/harness/src`: 0 readers); the app
  reads `description` (UIs, `ConfigTools.ts:85`). `category` is a free
  string read by one surface, the CLI `/config` panel, which labels it in
  its own table (`packages/cli/src/chat/tui/forms/configCategories.ts:6-16,31`;
  `privacy` has no entry and falls to a capitalized fallback).
- Which snapshot a row belongs to doubles as its rebroadcast key: "The
  `agents` snapshot controls rebroadcast routing, not tab placement; the
  Subscriptions control reuses it because no subscriptions snapshot exists"
  (`settingSurfaces.ts:142-143`), a comment explaining a hand-off.
- `TEXRA_CONFIG_ROWS` is a record of a union of two row types
  (`texraSettings.ts:105-109`), told apart by `'surfaces' in row`
  (`:284-286`).

**The design decision behind it.** "What is a setting, and where is it
shown?" #14467 answered the second for surfaces (the app's) but left
`category`, a placement, on the harness row, and kept copy optional so a
row could be unshown; "shown" became a property of which optional fields are
present.

**The better design.** Copy is what a setting is, so every row carries it:
`title` and `description` required on `SettingRow` (26 config-file rows,
9 harness and 17 TeXRA, need a title written; the state keys of finding 4 carry no copy and are
no rows). `category` moves onto the app's `Placement`, as a
`Schema.Literals` vocabulary the CLI's label table is total over. Then
"shown" has one representation, the placement, and with finding 3's typed
rows `HARNESS_ROW_SURFACES` is a `Record<HarnessRowKey, Placement | null>`,
so a missing or extra placement is a compile error. The snapshot's
rebroadcast role goes with J5 (one settings snapshot).

Deleted: `placeRows`' two copy checks and its "has display copy but no UI
shows it" throw, `titledRow`'s throw, `category` on `StateSettingEntry` (24
assignments in `stateSettings.ts`, 13 in TeXRA's row modules),
`hasOwnSurfaces`, the union in `TEXRA_CONFIG_ROWS`.

**What we give up.** The unknown-key check of `HARNESS_ROW_SURFACES` moves
from load time to the compiler, which is stronger; nothing is lost for a
user. 26 titles to write.

**Change amplification.** "Show an existing harness row in `/config`":
today `settingSurfaces.ts` and a `category` on the harness row (2 packages,
the second a harness edit for an app decision); after, the placement (1).

**Depends on:** finding 3 for the typed placement key; J5 (lane 3.4) for
the snapshot's routing half. The copy and `category` half can land alone.

---

## Finding 6. A run's spend has two schemas, four summers and two pricing rules; one counter has no reader and a comment promises a compile error that does not happen

**Red flags:** two representations of one fact; a false comment; change
amplification.

**Evidence.**

- `TokenUsageStatsSchema` (`shared/schemas/usage.ts:37-55`) and
  `RunUsageTotalsSchema` (`:121-131`) are the same seven counters and cost,
  the second renamed `total*` and with one more field, `firstInputTokens`.
  `firstInputTokens` is written (`shared/schemas/runInput.ts:52-55`) and
  summed (`usage.ts:155-156`) and read by nothing (0 readers in production,
  tests and docs). Of the `total*` fields, production reads `totalCost`
  once (`packages/harness/src/agent/runtime/loop/toolUse.ts:500`); the token
  totals are read by tests only (`src/test-kernel/effect/sessionPrograms.vitest.ts:253-256`,
  which compares `view.outputTokens` with `usage.totalOutputTokens`: the two
  shapes of one number side by side).
- Four summers: `sumUsageStats` (`usage.ts:95-112`, generic over the
  fields), `sumRunUsageTotals` (`:149-158`, generic over the other schema's
  fields), `addTurnUsage` (`runInput.ts:46-70`, field by field) and two
  empty values (`emptyUsageStats`, `:66-77`; `EMPTY_RUN_USAGE_TOTALS`,
  `:136-146`).
- `addTurnUsage`'s comment says "Every field of the totals is named here, so
  a new metric on either schema is a compile error rather than a silent
  zero" (`runInput.ts:43-44`). A new counter on `TokenUsageStatsSchema`
  compiles: the function only constructs `RunUsageTotals`. It is the silent
  zero the comment rules out.
- "Which rows carry a run's spend" is decided twice: `pricedUsage` for the
  `run_usage` projection (`packages/harness/src/controllers/session/projections.ts:87-99`:
  `response`, `failed`, `context.edit`, `run.description`), and the run
  state's three handlers plus the run end's label
  (`shared/session/runState.ts:436`, `shared/session/turnRowHandlers.ts:200,216`,
  `packages/harness/src/agent/storage/runRecords.ts:221-223`). The view
  sums `TokenUsageStats` (`shared/session/sessionViewUpdate.ts:441,955`),
  the run end `RunUsageTotals` (`runRecords.ts:251-258`).
- Consumers: `RunUsageTotalsSchema` 5 references in 2 files,
  `sumRunUsageTotals` 3 in 2, `addTurnUsage` 8 in 4,
  `EMPTY_RUN_USAGE_TOTALS` 7 in 3; `TokenUsageStatsSchema` 13 in 5,
  `sumUsageStats` 10 in 5.

**The design decision behind it.** "What is a run's spend?" It was given a
second shape when run totals were first recorded, and the row folds grew
around each shape separately.

**The better design.** One counter set, `TokenUsageStats`; a run's spend
is a `TokenUsageStats` summed by `sumUsageStats`; `RunState.usage` and
`RunEnd.usage` are that type. "Which rows are priced" is `pricedUsage`
alone, moved to `shared/session/` where the run state's handlers and the
projection both call it. `NormalizedUsageSchema` stays the per-call row
shape (`runInput.ts:28-35`, `mapFields(Struct.assign)` over the counters,
already derived).

Deleted: `RunUsageTotalsSchema`, `RunUsageTotals`, `EMPTY_RUN_USAGE_TOTALS`,
`sumRunUsageTotals`, `addTurnUsage` and its false comment, `firstInputTokens`;
three pricing spellings in the run-state handlers and the run end.

**What we give up.** The CLI's JSON output carries `RunEnd`
(`packages/cli/src/schemas/cliOutput.ts:76`): `result.usage.totalInputTokens`
becomes `result.usage.inputTokens`, `totalCost` becomes `cost`, and
`firstInputTokens` disappears. That is a break of a published output shape;
R6 accepted the same kind of break for the NDJSON `status` word. No stored
row changes: `RunEndRowSchema` omits usage (`shared/schemas/runRecords.ts:108`)
and `RunState` is a fold.

**Change amplification.** "Add a usage counter": today
`TokenUsageStatsSchema`, `emptyUsageStats`, `RunUsageTotalsSchema`,
`EMPTY_RUN_USAGE_TOTALS`, `addTurnUsage` (the last silently skippable) and
llm's pricing into the row (`agent/runtime/run/pricing.ts:25-52`): 6 sites;
after, the schema, `emptyUsageStats` and pricing (3, all compile-forced or
generic).

**Depends on:** none. The run-state handlers are C's files; the change is a
type substitution there, no new fold.

---

## Finding 7. A subscription session that cannot be read becomes a "state read" failure, then a route failure without its session facts, then a "host fact" failure nothing branches on

**Red flags:** error handling that should be defined out of existence (an
`Effect.try` over a read that cannot throw); catch sites that re-classify;
an error kind nothing branches on (AGENTS.md "No option for a special
case"); two mappings of one failure.

**Evidence.**

- `subscriptionOn` (`model/modelSettings.ts:163-193`) wraps
  `SubscriptionPreference.get` in `Effect.try` (`:167-174`). That read is
  `Settings.getConfig` (`subscriptionAccess.ts:27-35`) over `JsonStore.get`,
  which catches its own file errors (`platform/defaults/jsonStore.ts:189-211`);
  the only throw left is `entryOf`'s missing row, a defect, which the
  `Effect.try` turns into a typed `StateReadFailed` with `key: 'chatgpt'`,
  not a setting key.
- The same function maps the sign-in read's `SecretsFailed |
  SubscriptionOAuthError` (`packages/llm/src/oauth/chatgpt/chatgptProvider.ts:386-393`)
  to `StateReadFailed` (`modelSettings.ts:182-189`), and the Kimi Code key's
  `SecretsFailed` likewise (`:220-230`). A sign-in is not application state.
- `ModelAccess` maps that to `RouteUnavailable.of` (`agent/runtime/modelAccess/ModelAccess.ts:122-124`,
  `common/errors/agentErrors.ts:58-60`), which fills only `message` and
  `cause`. In `credentials.ts`, `subscriptionUnavailable`
  (`agent/runtime/modelAccess/credentials.ts:57-73`) maps the same session
  failure to a `RouteUnavailable` with `session: { route, needsReauth }`,
  which `providerErrorFormat.ts:107` words as "sign in again". So a session
  read that fails at the settings read loses `needsReauth`; the same failure
  one step later keeps it.
- `computeModelOptions` re-wraps every host read as `ModelHostFactUnreadable`
  (`model/computeModelOptions.ts:183-203`, applied at `:218-221, 565-568`).
  Nothing catches or branches on the tag: its consumers list it in error
  unions beside `StateReadFailed`
  (`packages/texra/src/controllers/session/hostRunActions.ts:107-110,148-158`)
  and the `./host` entry exports it (`packages/harness/src/host.ts:157`).
  Neither tag is in the storage-errors inventory.

**The design decision behind it.** "What failed?" is answered by the layer
that noticed, three times, each time with its own tag and less of the
original.

**The better design.** The failures keep their own types up to the one
place that decides what they mean. `readModelSettings`'s error channel is
`StateReadFailed | SecretsFailed | SubscriptionOAuthError`; the
preference read is a plain `boolean` (no `Effect.try`); `ModelAccess`
handles `SubscriptionOAuthError` with `Effect.catchTag` (`Effect.d.ts:4392`)
through the existing `subscriptionUnavailable`, so both paths carry the
session's route and `needsReauth`; `readModelOptions` fails with what its
reads fail with.

Deleted: the `Effect.try` and three `StateReadFailed` constructions in
`modelSettings.ts`, `ModelHostFactUnreadable` and `hostFact` (1 class, 1
helper, 3 uses; 1 `./host` export), and the `RouteUnavailable.of` mapping
at `ModelAccess.ts:124` (one of its six uses).

**What we give up.** A per-entry-point label ("Could not read the model
settings from the host"); the message becomes the failure's own.

**Change amplification.** "Show 'sign in again' when the session read at
bind fails": today impossible from this path without editing
`modelSettings.ts`, `ModelAccess.ts` and `computeModelOptions.ts`; after, it
already does.

**Depends on:** O3 (lane 1.4) replaces `getChatgptStatus`/`getXaiStatus`
and the `chatgpt | grok` parameter with an account service; this finding's
error half can land first. `ModelAccess.ts` and `credentials.ts` are the R9
driver's (package E): coordinate before touching them.

---

## Finding 8. Smaller items, batched

a. **Proposal fields restate the agent config's.** `BaseProposalFieldsSchema`
   (`shared/schemas/proposalFields.ts:7-42`) restates seven fields of
   `AgentConfigObjectSchema` (`agentConfig.ts:50-89`), with the comment
   "Mirrors `agentSource` on the agent config payload" (`:13`) standing in
   for a derivation, and `ProposalFileFields` (`:60-66`) restates the four
   file lists by hand. `AgentConfigObjectSchema.mapFields(Struct.pick([...]))`
   with the required overrides would state each once; it borders G11d's
   launch schema and R7's request payloads.
b. **Enum copy as parallel arrays.** `enumLabels` and `enumDescriptions` are
   "aligned 1:1 with the schema's enum options" (`stateSettings.ts:97-104`)
   by index, unchecked: a missing label falls back to the value, an extra
   one is ignored, a reordered schema relabels silently
   (`packages/texra/src/shared/settingsView/settingRows.ts:58-71`). A
   `Record<typeof schema.Type, { label, description? }>` is total by type.
   Five rows.
c. **Copy that restates llm-zoo.** `CHATGPT_CODEX_CONTEXT_WINDOW_SETTING`'s
   description names per-model windows ("500 for GPT-6.1 Sol, 272 for the
   others", `coreSettings.ts:71`) that llm-zoo's `codexSubscription.contextWindow`
   owns, and `max: 872` (`:68`) is a constant beside them; the region
   toggles' descriptions spell the endpoint hosts
   (`shared/state/providerSettings.ts:47-74`) that `providerPlugins.ts:103-132`
   holds. Each llm-zoo bump can make the copy false. Word the copy without
   the numbers, or derive them. (O9a covers the rows themselves.)
d. **A pure decision that throws, wrapped twice.** `chooseReasoning`
   throws `ReasoningChoiceError` (`packages/llm/src/models/reasoningChoice.ts:129,174,184,206`);
   the harness catches it with `Result.try` and `ensureError`, dropping the
   tag (`model/reasoningLevel.ts:93-104`), and `decideReasoning` re-lifts it
   with `Effect.fromResult` (`:113-120`). If llm returns
   `Result.Result<ReasoningChoice, ReasoningChoiceError>`, `chooseOnRoute`
   goes and `decideReasoning` is `Effect.fromResult` at the bind. In llm's
   file, so lane 7 (O2) with the R9 driver.
e. **`ModelAvailabilityKind` splits by subscription what `usageRoute`
   already says.** `'subscription-access'` and `'xai-subscription-access'`
   (`shared/schemas/modelAvailability.ts:18-21`) differ only by the route
   each option also carries (`computeModelOptions.ts:151-154`); their two
   readers switch on both (`packages/cli/src/runtime/modelAccess.ts:260-261`,
   `packages/texra/src/ui/copy/modelAccess.ts:32-33`), and the label could
   come from the plan copy keyed by route in the same file. The
   `requiresKey` column is true for exactly the `missing-key` row
   (`modelAvailability.ts:41-49`; 1 reader, `ModelSelectionList.ts:186-190`):
   a derivable column. The `unknown-model` builder is unreachable by its own
   comment and restates `optionOf`'s sentence (`computeModelOptions.ts:83-85`, `:504`).
f. **A stage protocol held by a throw.** "A provider absent from the map was
   never read" (`computeModelOptions.ts:92-99`) and its defect throw
   (`:163-168`): if stage 2 wrote each routed model's key status into its
   `RoutedModel`, the absent case could not be expressed.
g. **Two copies of one copy.** The Google server-state Models-tab control
   restates the row's title as its `label` and paraphrases its description
   (`settingSurfaces.ts:126-136`), though `label` defaults to the title
   (`:28-31`).
h. **`agentSkills.ts` is two topics:** the skills switch's key, default and
   schema (`:6-10`) and installed-plugin trust (`:26-71`). The first goes
   with finding 3.
i. **A write decodes twice.** `applyStateSettingUpdate` decodes the value
   (`packages/texra/src/shared/settingsView/handlers/stateSettingWrite.ts:80-84`)
   and `Settings.set` decodes it again and throws on failure
   (`settings.ts:348-355`). Harmless while every row's type equals its
   encoded form; `set` should encode what it stores (`Schema.encodeSync`,
   `Schema.d.ts:1902`) once a row's two forms differ.

---

## Good modules in this area

- **`Settings` and `StoredSetting`** (`shared/config/settings.ts:153-162,
  280-295`): a checked read with an explicit `invalid` case, and `inspect`
  for a gate that must fail closed. Findings 1 and 2 make it the only
  reader; its shape stays.
- **`settingsCatalog`** (`stateSettings.ts:636-695`): the namespace as data,
  a duplicate key refused at build, an app default validated against the
  row's schema where the catalog is built, not at the first read.
- **`JsonConfigProvider` with `MemoryConfigProvider`**
  (`jsonConfigProvider.ts:62-136`, `memoryConfigProvider.ts:28-44`): one
  tier rule over two store backings, and `projectValueIgnored` shared by the
  read and the open-time warning.
- **`readModelOptions`** (`computeModelOptions.ts:544-574`): one read
  behind every picker, run-model check and prospective route (30
  references in 15 files); the shared facts read once, each model routed
  once, one key read per provider consulted, the rest pure.
  `UNAVAILABLE_REASON_BUILDERS` (`:58-86`) is compile-checked against the
  status table.
- **`readModelSettings` and `routeFactsFor`** (`modelSettings.ts:195-297`):
  every model-access setting read once into one value; "a run declined a
  plan" is a pure filter, not a preference write.
- **`decideRunModel` and `RUN_MODEL_REASONS`** (`model/runModelDecision.ts:76-163`):
  precedence and fallback mode in one table, one pure function, four
  callers in three packages.
- **`setModelEnabled`** (`computeModelOptions.ts:394-452`): one
  read-modify-write through `StateStore.modify`, its two invariants refused
  as typed failures, the stored delta re-encoded from what the picker shows.
- **`reasoningEffortOverrides`** (`reasoningLevel.ts:32-58`): the one decode
  of a stored record, warning per bad entry and never rewriting storage.
- **The coverage checks against llm's catalog** (`modelSettings.ts:50-69`,
  `reasoningLevel.ts:65-69`): a provider llm adds fails the build until its
  rows exist.
- **`settingEnumOptions`** (`settingRows.ts:36-49`): the dropdown's values
  read off the schema's AST rather than restated.
- **`RetryErrorInfoSchema`, `ErrorLogDataSchema`** (`shared/schemas/errors.ts:79-107`):
  derived with `mapFields(Struct.omit / Struct.assign)`, not restated.

## Already settled, left alone

- **Effect `Config` for settings** (`EFF-ADOPT-config-provider`,
  `refuted-candidates.json`): not proposed. Finding 3's typed row is the
  existing row used as the key; reads stay synchronous where the ruling
  keeps them (`settings.ts:297-313`).
- **The ports in `shared/config/settings.ts`**: merged there on purpose by
  #14505 (release PRD lane 9, slice 2), so one module says where settings
  live and how they are read.
- **`settingsCatalog`'s `defaults`** for one key (the helper model): the
  embedder's seam for a harness row's default, decided in d13 (#14551).
- **Surfaces in the app** (#14467): kept; finding 5 narrows what the join
  still infers.
- **`projectMayOptOut`**, a column one row sets: the privacy rule the
  harness guide states; after findings 1 and 2 it is read in one place.
- **`Settings.set`'s `target`**: two callers (`subscriptionAccess.ts:57`,
  `ConfigTools.ts:128`), not a special-case option.
- **`shared/schemas/index.ts` as a barrel**: AGENTS.md makes
  `@shared/schemas` the import and forbids leaf imports; a documented
  surface.
- **`DEFAULT_MODELS`**: a curated app choice, not a catalog fact, with a
  test that fails the bump that invalidates it.
- **The provider rows and their count, the subscription id spellings, the
  config defaults behind the launch pre-check, the settings snapshot
  messages, the transport knobs, the row kinds**: O9a, O3, G11d, J5/G8,
  the processing-options inventory, C/B/R7 (see the top).
- **`computeModelOptions.ts`'s four stages**: private functions of one
  deep module with one entry, staged for a real reason (key reads are
  batched after routing); not temporal decomposition. Item 8f is the only
  cost.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

Checked in `node_modules/effect/dist/*.d.ts` (version 4.1.2,
`node_modules/effect/package.json`); line numbers are into those files. Most
findings here are data and schemas: AGENTS.md keeps pure computation plain
TypeScript, and a `Schema` is the Effect-native form of a refused case, so
several rows name no fiber primitive on purpose.

| Finding | Hand-rolled today | The primitive or structure that answers it | Declaration checked |
| ------- | ----------------- | ------------------------------------------ | ------------------- |
| 1 | the CLI's `withoutInvalid` store wrapper; telemetry's `typeof` check; five readings of an invalid value | one decode in `Settings` (`Schema.decodeUnknownResult` into `StoredSetting`), `Settings.inspect` as the fail-closed read | `Schema.decodeUnknownResult`, `Schema.d.ts:1402`; `Result.isSuccess`, `Result.d.ts:691` |
| 2 | `rawConfigValue`'s `global` branch restating `projectValueIgnored` | none: `projectValueIgnored` is the one tier rule (plain TypeScript) | — (deletion) |
| 3 | `Settings.get<T>(stores, key: string)` and 94 call-site type arguments; `*_SETTING` bounds beside the schema | `SettingRow<A>` with `schema: Schema.Codec<A, unknown>`, assignable to the catalog's `Codec<unknown, unknown>` because `T` is covariant; bounds by `Schema.isBetween`, read back with `Schema.toJsonSchemaDocument` | `interface Codec<out T, out E = T, …>`, `Schema.d.ts:856`; `isBetween`, `:6117` (emits `minimum`/`maximum`, `Schema.js:4572-4573`); `toJsonSchemaDocument`, `:12272`; `withDecodingDefault`, `:4996` |
| 4 | `Settings.state(store, key, schema)` with the schema per call; two rows read around the catalog | `StateKey<A> = { key, slot, schema }`, read by `Settings.state(store, key)`; writes through the existing `StateStore.modify` | `Schema.Codec`, `Schema.d.ts:856` |
| 5 | optional copy, `placeRows`' inference, `titledRow`'s throw; `category` on the harness row | required `title`/`description`; `category` as `Schema.Literals` on the app's placement; `Record<HarnessRowKey, Placement \| null>` | `Schema.Literals`, `Schema.d.ts:4188` (and `.pick`, `:4164`) |
| 6 | `RunUsageTotalsSchema`, `addTurnUsage`, `sumRunUsageTotals`, `EMPTY_RUN_USAGE_TOTALS` | one `Schema.Struct` of counters summed over `Struct.keys`; per-call shape by `mapFields(Struct.assign)` (already so) | `Struct.keys`, `Struct.d.ts:228`; `Struct.assign`, `Struct.d.ts:418`; `mapFields`, `Schema.d.ts:2987` |
| 7 | `Effect.try` over a non-throwing read; `StateReadFailed` for a sign-in; `hostFact`'s `Effect.mapError` into a tag nothing reads | the typed channel as the reads produce it; `Effect.catchTag('SubscriptionOAuthError', …)` once at the bind, through `subscriptionUnavailable` | `Effect.catchTag`, `Effect.d.ts:4392`; `Effect.mapError`, `:6112` (removed); `Schema.TaggedError`, `Schema.d.ts:11985` |
| 8d | `Result.try(chooseReasoning)` with `ensureError`, then `Effect.fromResult` | llm's decision returns `Result.Result<ReasoningChoice, ReasoningChoiceError>`; `Effect.fromResult` at the bind | `Effect.fromResult`, `Effect.d.ts:2470` |
| 8b | `enumLabels`/`enumDescriptions` aligned by index | `Record<typeof schema.Type, Choice>`, total by type | — (types) |
| 8i | `Settings.set` stores the decoded value | encode what is stored | `Schema.encodeSync`, `Schema.d.ts:1902` |

There is no `Layer.scoped` in 4.1.2 and none is needed here: nothing in
this area holds a resource.
