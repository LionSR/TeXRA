# Harness package guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md) for
`packages/harness` (`@texra-ai/harness`).

## Directory organization

- `packages/harness/src/common/` holds host-neutral, cross-cutting logic with domain meaning (errors, parsing, plugins, storage). Check a module's dependencies before using it from browser code.
- `packages/harness/src/utils/` is host-agnostic, not browser-safe: an import added to a module in the closure of the `./schemas` or `./transcript` entry must stay browser-safe. `utils/core/` has the browser-safe path basics (`pathBasics.ts`) and the Node path rules (`pathCore.ts`), the backoff delays (`backoffSchedule.ts`), HTTP status reads, hashing (`idHash.ts`), and `withPerKeyLane` (`perKeyQueue.ts`).
- `packages/harness/src/platform/` defines the host ports and the process runtime types. Each host's composition root builds one `ManagedRuntime` over `processLayer()` and opens and closes sessions through its `SessionOwner`.
- Hosts and the app hold a session as the public `Session` (`packages/harness/src/effect/sessions.ts`): its view, a run's records (`records(runId)`), the run listing and deletion, its starts, resumes and requests, all typed; `Sessions.open` gives the `LocalSession` this process holds, which adds the runs it is running (`held`), a handle by activation (`run`) and its notices (`emit`). A window of the background service holds a plain `Session` the service answers (`packages/texra/src/controllers/server/serviceSession.ts`). Inside the harness a session is its owners, each its own service (`SessionServices`, `packages/harness/src/agent/runtime/rootLaunch.ts`, composed in `packages/harness/src/controllers/session/sessionOwners.ts`), which its runs, requests and the SDK read from context; a host never names them.

## Layer order

The top-level directories of `packages/harness/src`, bottom first. An import
points to a strictly lower layer:

1. `logger/`: log channels and the log sink; `types/`: ambient module declarations. Neither imports anything in the harness.
2. `utils/`: helpers with no domain owner.
3. `shared/`: wire contracts, schemas, the session row model and its folds.
4. `common/`: cross-cutting logic with domain meaning (errors, parsing, storage layout).
5. `platform/`: the host ports and the process runtime types.
6. `model/`, `skills/`: model capabilities and pricing; skill discovery.
7. `agent/`, `tools/`: the run runtime with its storage reads, and the tool
   engine with the built-in tools. They import each other.
8. `controllers/`: the SQLite session stores and the session composition.
9. `effect/`: the SDK (`Sessions`, `processLayer`).
10. The entry files at the root (`index.ts`, `builtins.ts`, `node.ts`, `plugins.ts`, `schemas.ts`, `host.ts`, `transcriptEntry.ts`).

The known exception: `agent/` and `tools/` form one cycle.

## Configuration, storage, and workspace files

- **Raw config paths.** Read with `config.get(path)` on the `ConfigProvider` the caller holds (a tool call's `call.roots.config`, a run's `SessionRoots` config, or a host command's `session.roots.config`) and write with its `update(...)`. There is no `updateConfig`/`watchConfig` helper and no change-notification API.
- **Catalog settings.** Nearly every setting is declared in the settings catalog by its owner: the harness's rows in `packages/harness/src/shared/state/stateSettings.ts` (the provider rows in `providerSettings.ts` beside it), TeXRA's in `packages/texra/src/shared/settings/texraSettings.ts`, and a plugin's in its own settings module, listed in TeXRA's rows. Each config provider carries its catalog (`ConfigProvider.catalog`: TeXRA's hosts pass `TEXRA_SETTINGS.catalog`, which the process layer's `settings` also takes; an embedder builds one with `settingsCatalog({ namespace, rows })` from `@texra-ai/harness/schemas` and hands it to `nodePlatform({ settings })`); there is no process-wide catalog.
  - Keys in code are relative to the catalog's `namespace` (`'memory.enabled'`); the namespace is added where a key is stored, in the config providers (`jsonConfigProvider.ts`) and the state stores (`appStateStore.ts`), so TeXRA's stored keys read `texra.memory.enabled`. Code that reads a stored key back (a config file's keys) strips the namespace once.
  - Read and write a setting with `Settings` (`packages/harness/src/shared/config/settings.ts`: `Settings.get(stores, ROW)`, `.set`, `.reset`), which validates. A row is a value (`SettingRow<A>`, an object literal `satisfies SettingRow<A>`), and it is the handle: its schema types the value, so a reader names no key and no type, and its bounds are its schema's. A generic UI passes the row it iterates and gets `unknown`; a stored key read back from a file is looked up once with `catalog.byStoredKey`. Every row carries its `title` and `description`. Where TeXRA shows a row (its placement: `category`, `surfaces`) and what a write entails (`onWrite`) are the app's, declared on TeXRA's rows and, for the harness's rows, in `packages/texra/src/shared/settings/settingSurfaces.ts`, whose `HARNESS_ROW_SURFACES` is total over the harness's rows (`HarnessRowKey`; `null` for a row no UI shows); the harness reads none of it. A row's `onWrite` is applied by the writers a person drives (the settings UIs' shared write handler, `settingsViewBody.ts`, and the CLI `/config` form, `CliConfigForm.tsx`), never by `Settings.set`. `stores` are the settings slots the caller holds (a `WorkspaceRoots` is a `SettingsStores`); there is no ambient reader.
  - Which scope answers for a key is the config provider's rule (`projectValueIgnored`, `jsonConfigProvider.ts`): a `configTarget: 'global'` or `'local'` row ignores the project file, except that a `projectMayOptOut` row (telemetry) takes a project's opt-out but never its opt-in. `Settings` reads every row through `config.get` and restates no scope rule.
  - A write reachable from a settings UI (extension/desktop `UPDATE_STATE_SETTING`, CLI `/config`) goes through `applyStateSettingUpdate` (`packages/texra/src/controllers/settingsView/stateSettingWrite.ts`), which adds the open-workspace guard; its callers apply the row's write consequences (`onWrite`, the approval-policy repaint).
- **Files.** Inside Effect, use the rooted services (`WorkspaceFs`, `StorageFs`, `GlobalStorageFs` in `@platform/rootedFs`), which refuse a path escaping their root. Workspace path math is pure in the root (`@utils/files/workspaceFS`); outside Effect, every run-directory helper in `@common/storage/storageLayout` takes the storage root as its first parameter. Nothing in `@utils/files` or `@common/storage` resolves a root on its own.
- Pasted images: names from `@texra/shared/utils/pastedImageName`, paths from `@texra/utils/files/pastedImageUtils` (keeps Node filesystem code out of browser bundles).
- Discover files with `listWorkspaceFiles` (`packages/texra/src/common/files/workspaceFileListing.ts`) and agents with `AgentCatalog`; don't duplicate discovery.

## Agent execution

- An agent is one definition format (`AgentDefinitionSchema` in `@shared/schemas`, a YAML file or an SDK inline persona) launched with an `AgentConfig` (`packages/harness/src/shared/schemas/agentConfig.ts`).
- Launch a root run with `session.start` (`packages/harness/src/effect/sessionPrograms.ts`): it mints the `runId` when the input names none and runs `rootRun` (`packages/harness/src/agent/runtime/rootLaunch.ts`), which registers the run through `RunRegistry.start`; the registry refuses a launch on a session that is closing. Which options a start takes, and when one belongs on the agent config instead, is stated on `StartOptionsSchema` (`packages/harness/src/shared/session/runtimeRequest.ts`). A persisted run resumes through `resumeRun`. `executeAgent` is the one run program, fresh (with its registration) or resumed; it is the `Launch` (`open`, `run`, `end`) that a fiber `RunRegistry.start` forks runs, so only a caller that owns the `runId` reaches it (a resume, or a child's launch, `packages/harness/src/agent/runtime/delegation/childLaunch.ts`). Every child is a run that ends: a native child runs one cycle under `executeAgent` and a process child (a background command, an agent CLI's turn) runs one turn under `launchProcessChild` (`packages/harness/src/agent/runtime/processRun.ts`); the child's `run.end` transaction queues its report on the input of each run it worked for (`reportRecipients`, `packages/harness/src/shared/session/runRowReads.ts`: the runs whose messages it took since its last end, and its parent until its first end or when nobody asked), and a later message to it is a resume. Attach presentation and approval behavior to the session's `Interactions` (`attachInteractions`).
- A new provider is data, not a handler class; the `helperModel` path binds through the same route. Routes and API-key credentials in `packages/harness/src/agent/runtime/modelAccess/` are generic over `ApiKeyProviderId`, so a key provider adds nothing there. The places it touches, all but the first compile-enforced:
  1. An llm-zoo release with the `ModelProvider` value and its models (capabilities and prices live there; `turnCost` reads them), then the exact `llm-zoo` pin in `packages/llm/package.json`. Not enforced.
  2. `MANIFEST` and `BACKEND_PROTOCOLS` in `packages/llm/src/providers/providerPlugins.ts` (its `AssertNever` gates).
  3. Its row in `RESPONSES_ROUTES` (`packages/llm/src/api/responsesConfiguration.ts`), where its quirks go; a provider on a new protocol is a `CONFIGURE` case in `api/configuration.ts` instead.
  4. Its key shapes (`API_KEY_SHAPES` in `packages/llm/src/providers/providerPlugins.ts`), which log redaction and the CLI's credential check read.
  5. The stored provider list `MODEL_PROVIDERS` (`shared/schemas/runInput.ts`), which `ModelBackendSchema` (gated in `model/reasoningLevel.ts`) and `ApiKeyProviderIdSchema` (`shared/schemas/requestPayloads.ts`, checked by assignment in `routeDecision.ts`) both read. A run's `binding.backend` is stored as a string and read as written, so removing a provider from the list bumps no row version: a run bound to it stays readable, and its next bind is refused by name (`decideRoute`).
  6. Its endpoint row and region toggle in `shared/state/providerSettings.ts` (gated in `model/modelSettings.ts`); their placements in `packages/texra/src/shared/settings/settingSurfaces.ts` (`HARNESS_ROW_SURFACES` is total over the harness's rows).
  7. The app's key page (`KEY_PAGES`, `packages/texra/src/shared/model/keyPages.ts`) and setup probe model (`SETUP_MODEL_BY_PROVIDER`, `packages/texra/src/model/setupModelDefaults.ts`); the Models tab's source order is `API_KEY_PROVIDER_IDS` itself.

  A quirk outside the request (the DashScope, Gemini and Kimi reasoning rules in `routeControls`, `packages/llm/src/models/reasoningChoice.ts`) is not enforced.

- A subscription plan is a `PLAN_ROUTES` row in `packages/llm/src/errors.ts`. Once it is added, the compiler stops at each place that decides something per plan: when it serves a model and what config it runs with (`PLAN_DECISIONS`, `routeConfig`, `packages/llm/src/models/modelRoute.ts`), how its limit reply reads (`PLAN_LIMITS`, `packages/llm/src/api/verdict.ts`), its effort ceiling (`PLAN_EFFORTS`, `reasoningChoice.ts`), how its quota is learned (`PLAN_QUOTA_SOURCES`, `packages/llm/src/providers/planUsage.ts`: an endpoint asked with its key, its replies' headers, or nothing, and an endpoint plan's request), its Responses request (`packages/llm/src/api/responsesConfiguration.ts`), its switch (`on` in `packages/harness/src/model/modelSettings.ts`), and the app's plan name and usage badge (`packages/texra/src/ui/copy/modelAccess.ts`); the stored route lists (`DeclinableUsageRouteSchema`, `packages/harness/src/shared/schemas/usage.ts`) are its keys. A `session` plan also needs its account (`SubscriptionAccounts`, `packages/llm/src/oauth/subscriptionAccounts.ts`), its credential (`subscriptionCredential`, `modelAccess/credentials.ts`) and its sign-in id (`SUBSCRIPTION_ROUTES`, `packages/harness/src/shared/model/subscriptionAuth.ts`, checked total over the session plans), which the settings sections and the CLI read. A `key` plan also needs its coding-plan catalog row (`packages/texra/src/shared/model/codingPlans.ts`, keyed by route) and, for a usage meter, its id in the stored usage enum (`packages/texra/src/shared/model/subscriptionUsage.ts`). Not enforced: the model eligibility the plan reads from llm-zoo, the setup probe and the hosts' sign-in commands (ChatGPT only). The step that puts a plan in one row: `.agents/docs/proposed/architecture/2026-11-19-a-subscription-plan-is-one-row.md`.

## Run loop architecture

A run is one Effect program in `packages/harness/src/agent/runtime/loop/`, with no cursor and no graph:

- **One program**: `runToolUse` (`loop/runLoop.ts`, `loop/toolUseDispatch.ts`). A plugin's program (`Plugin.programs`) runs it on a generated two-line script that imports the program's module and calls its default export (`script.kind: 'program'`, `runtime/programRun.ts`). A site asks a script run's facts through the predicates in `shared/schemas/runRecords.ts`, never the raw field: `runsScript` (its one response is its script call: no prompt, no skills, one cycle, nothing to fork), `programOf` (a program), `programOrigin` (where its program comes from, listed, installed or own, which decides its tools, whether the runs it starts stand approved, and how the files it hands them resolve) and `backgroundScriptOf` (a background script, whose end is a script delivery). `loop/rows.ts` builds every draft the loop appends; `packages/harness/src/tools/core/toolCallParsing.ts` parses tool calls.
- **State is row data.** The loop holds no copy of the conversation: it continues from the `RunState` (`packages/harness/src/shared/session/runState.ts`) that `RunCell.append` (`shared/session/runHistory.ts`) returns, so live and resume are one function.
- **Services come from context**: `AgentRun` (`runtime/run/AgentRun.ts`) and `ModelInvoker` (the only caller of the `packages/llm` `Model`), provided once at the `executeAgent` boundary; the session's own services (`SessionServices`: its `RunHistory`, `RunRegistry`, log, view and the rest) from the fiber `RunRegistry.start` forks, whose context the session layer captured. No services bag.
- **A run's input queue is its own.** A run opens its follow-up reader in its own scope (`claimFollowUps`, `runtime/FollowUps.ts`). A launch hands its run nothing of the launcher's context but its `LaunchKeys`, and a queue taken from the session's context would not be the run's. A note a run writes to itself for a later time (the `wake` tool, `packages/harness/src/tools/WakeTool.ts`) is a row of that queue too, queued when the run asks and readable from its due time (`FollowUpSender` `self`): a run a fiber drives waits for it in its own reader, the session resumes a run no fiber drives when the time comes or, late and once, at its next open (`wakePendingNotes`, `packages/harness/src/agent/followUp/ToolUseFollowUp.ts`), and a stop of the run drops the notes it has pending.
- **Write points are the contract**: a `model.message attempt` before a billed request leaves the process; the `response` row before any tool dispatches; `tool.intent` as each call's body starts (after hooks, guard and approval); `tool.result` before the loop continues; a `run.position` for every wait, and the `run.end` for every end. Every fact the loop branches on is a row field the run state reads; no row restates loop state.
- **Two loops, one per kind of call.** A turn's is `ModelInvoker.invoke` over the invocation's rows: `nextAttempt` (`shared/session/inFlight.ts`) decides from them, and each failed attempt commits a `failed` row naming what follows (`retry`, `unchain`, `ask`, `stop`). Automatic resends run under the process's `ModelRetryGate` within a budget counted from the recorded failures; past it, the `failed` row opens a retry request and the person's `request.decided` starts the next attempt. A resume restarts from the last recorded outcome: an attempt no row saw end counts as not made and is sent again, and a retry request an earlier lifecycle left cancelled is not asked again, since resuming the run is the person's word to go on. An accepted background operation is observed, never resubmitted. A call off the rows (a compaction summary, a helper call) is `callModel` (`run/modelCall.ts`): `Effect.retry` under the same gate while llm says the request can succeed, no row written; a summary's usage rides the `context.edit` that lands it. Provider SDK retries stay disabled.
- **Requests are a closed set.** The kinds a run asks a person are the harness's own (`RequestPayloadSchema`, `packages/harness/src/shared/schemas/request.ts`), each with the answers it takes in `REQUEST_ANSWERS`; a plugin opens none of its own. Every request blocks the call (or, for a retry, the turn) that opened it, and one `request.decided` answers it and lets that waiting call go on. A resume cancels what a dead process left open, and the call asks again; a person's decision on such a request resumes the run instead, and its activation commits the decision for the call to take (`RunRegistry.holdAnswer`).
- **Interruption is the fiber's.** A durable append is uninterruptible; there is no `AbortSignal` threading inside the loop.
- **Lifecycle**: a run is one fiber from its launch's first step: `RunRegistry.start` forks it under the run's id on the session's context, and the fiber opens the run (its resources in a scope the fiber owns, then its registration or activation batch) and answers the launcher, which only waits for that answer; every exit of the run after its opening reaches the one terminal, `endRun` (`AgentRunLifecycle.ts`), which commits the `run.end` in one transaction (`endRunRows`, `agent/storage/runLifecycle.ts`); an end the store refuses fails the fiber, and the run reads as interrupted at its next open. A stop is a `run.stop` row (`user`, or `released` by the call that awaited the run) followed by the fiber's interruption (`RunRegistry.stop`); a stop that cuts a run's opening refuses its launch and ends the rows that opening committed, and a run no fiber drives ends CANCELLED in the batch that records the stop. A process that exits stops nothing: the session's close interrupts every fiber (`RunRegistry.interruptAll`) and the terminal writes no end for a run nobody stopped, so a quit leaves what a crash leaves, a run that reads as interrupted and resumes from its rows. A resume (`resumeRun`) is the same launch over the run's rows. The loop only executes.

## Plugin table

The plugins a run sees are the app's listed plugins (`processLayer`'s
`plugins`, validated once by `toolTable`) and the native plugins the
installed plugins load now (`harness.mjs`, `tools/nativePlugins.ts`, each
judged against the table by `withNatives`). The catalog owns the current
table (`ProcessCatalog.live`, `tools/liveTools.ts`), republished by every
read of the installed plugins. `ToolRegistry` holds one snapshot: the
listed table outside any run (a native plugin contributes nothing read
there: no row kinds, switch, probe or injected tools), the table a run's
launch read on its fiber (`executeAgent`), and the table a step read for
that step's calls (`ToolStep.services`). A plugin's layers are `RcMap`
entries keyed by id and revision (`LayerKey`), so a replaced native plugin's
new revision comes up beside the old one, which goes down when the last step
that pinned it ends; a swap interrupts nothing. A native module is imported
only when a step or a launch reads the table, from a copy of its plugin
made for that revision (`copyPlugin`, `common/plugins/pluginDigest.ts`) in
the process's own directory under `<global storage>/plugins/.native`: Node
caches a module by its path, so a revision imported from the plugin's own
folder would run the modules the first revision's entry imported, and the
copy is the files that were trusted whatever is written there afterwards.
The directory goes with the process (one a killed process left is removed
by the next loader); a change to the install record
only takes out what no longer loads, so listing, installing or reviewing a
plugin runs none of its code. The host decides how a native tool runs, not
its definition: the loader (`hostRun`, `tools/nativePlugins.ts`) gives
each the gate and deadline an MCP server's tool has
(`tools/thirdPartyTool.ts`), so every call asks under the session's
approval policy through the loop's one guard, and however it ends but by
interruption it ends that call alone, its error naming the plugin. A step
brings a native plugin's layers up before it offers anything of it
(`pinStep`, `tools/sessionTools.ts`). A revision that does not load (its
import, its value, the table's check or its layers) is not tried again
until its trust digest changes, and the revision of that plugin the table
held before it stays in use, in memory only, until the plugin is fixed,
disabled or removed (`previous`, `toolCatalogLayer`); with none, the
plugin is withheld. Either way the step says why. A call's tool is its
plugin's revision as its step recorded it (`sameIdentity`), so a resume
after a replacement or a disable runs no unfinished call of the old
revision again: it ends with its outcome unknown. Trusting a native
module is a person's own answer whatever the policy, and so is enabling
again one a person trusted and then disabled: `plugin_manager` opens that
request, a `pluginTrust` request (what the plugin is, where, what it
contributes and whether it carries native code). One that carries native
code asks the `trust` operation (`operationOf`, `agent/runtime/requests.ts`),
which only a person answers (`answeredBy: 'person'`), and where no person
can be asked it is denied.

## Event channels and cards

- Facts a run's trace emits extend `AgentEvent` and reach the session log through `runEventDraft` and the log's `publish`. Facts the session authors (lifecycle, status, approvals) extend `SessionRow` (`packages/harness/src/shared/schemas/sessionEvent.ts`) and commit through the log's `transact` (`SessionLogShape`, `packages/harness/src/shared/session/sessionLog.ts`). No `bus.emit` from a VS Code-free zone and no new subscribe surface (`.agents/docs/implemented/architecture/2026-06-10-error-pipeline-and-ownership.md`); `emitAppSignal(...)` stays within its documented scope.
- **One publisher.** Every write to a session's event table is a job of `SessionEvents` (`transact`, `detach`, `removeRun`), run where it is called as one uninterrupted turn: the driver is synchronous and a job awaits nothing, so commit order is call order and no job waits behind another. A job that awaits (a file read, another fiber, a timer) breaks that; there is no queue to put it in.
- **A tool card is its call's rows.** A call's `tool.intent` names the card its attempt opens and its `tool.result` the card it closes; a display read shows them as the card's `tool.start` and `tool.end` (`callCard`, `packages/harness/src/controllers/session/rowReader.ts`), live and cold alike. So every card opens as its call's body starts, and the loop stores no card row beside a call row: on a run with a run history the one stored card row is the `tool.start` of a call that ends before its body starts (denied, or its tool not in the run), committed in its result's batch. A stage is a labelled span no other row bounds: a plugin's section (`AgentTrace.stage`, closed once from the scope it opens in), or a script's calls. A run and a turn are not stages; their rows bound them. A script's stage writes no row: each call's card names the `script` card that issued it (`stageId`), and the transcript projects the stage from that card, open from its first call's card (again when a resume starts a call after its run's end closed it) until the script card closes. A stage still open at its run's end closes when the transcript applies that `run.end`, its one closer there; an open stage of a run nobody drives reads as interrupted. What a tool prints while running is transient text on the card id (`ToolContext.emit` → `stream.chunk`), never a row. No tool-side start card, durable progress row, or second append path.

## Storage format

`storeSchema.ts` (`packages/harness/src/controllers/session/`) holds two DDL lists, each with its own stamp: a project store's (`PROJECT_SCHEMA`: the event tables, the projections and the project's current values) and the global store's (`GLOBAL_SCHEMA`: current values and the input history, no event table). It stamps every store file (`<namespace>.db`: the settings catalog's namespace, served as `AppNamespace`, names it and the app's variables, so the harness spells no product) with its schema version and gives the schema to an unstamped file. A store stamped with another schema fails the open unchanged: a newer build's, or an earlier one this build has no step from (there is no migration; a column or table changes only with a stamp bump, and the message says to move the file away). A file SQLite reports damaged is renamed aside and a fresh store opened. The store checks nothing about the filesystem it is on. Row kinds carry their own versions (`packages/harness/src/shared/schemas/rowVersions.ts`), read only by the row codec (`rowCodec.ts`). A kind changes with no upcaster (the codec converts no stored row; the first released version that must stay readable across a change brings the first upcaster): bump its version when an older build's row would read wrong, so that row reads as an earlier build's (`DatabaseRowEarlier`) and never as damaged or silently stripped.

## Core quality

In the core (`CORE` in `oxlint.config.mts`), `any` (an error repo-wide), `!` (an error in every package's source and in the test suites, `src/test-kernel` and `packages/*/test`), an asserted object literal, `new Promise`, `.then(` and a stray `Effect.run*` are oxlint errors. `scripts/check-api-report.mjs` (in `gate:invariants`) fails when `config/api-reports/` or the API reference in `packages/{harness,llm}/docs/api/` differs from the package exports; `npm run docgen` regenerates both, so a public-surface or TSDoc edit lands with its diff. A merge keeps the branch's copy of those files (the `api-report` driver in `.gitattributes`, which `pnpm install` registers through `scripts/git-merge-drivers.mjs`), so after merging `main` run `npm run docgen` before committing; GitHub's own conflict check does not run the driver.

Two repo-wide counts of how many places decide one fact are held shrink-only against the merge base with `origin/main` by `npm run check:fact-spread` (`scripts/check-fact-spread.mjs`, in `gate:invariants`): the files containing each predicate in its `PREDICATES` list (`Cause.hasInterrupts`, `readOnly`, `parentId`, …) and the pairs of `Schema.Literals` or `as const` string sets in different files sharing three or more members. A count that rose fails, naming the new file or pair: decide the fact where it already is, or delete the older site in the same PR. `npm run report:fix-churn` prints the month's fix commits by scope and area; an area over ten re-asks its rulings in the next design pass (`.agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md`).

## Tool input schemas

The nullable-optional rule is in root `AGENTS.md` "Effect Schema Patterns".

- **A tool with commands is a `Schema.Union` of tagged structs**, each branch written for itself. `convertToolSchema` (`packages/harness/src/tools/core/toolSchema.ts`) alone shows it to the model as one object: the discriminator's literals as an `enum`, each other field labelled with the commands that take it, and every field not every branch requires nullable. Dispatch decodes with the union. OpenAI-compatible providers fill other commands' fields with `null`, and a `Schema.Struct` ignores undeclared keys, so never add a check that rejects unknown keys to a branch.
- A union-branch field with a default uses `nullishWithDefault` (`packages/harness/src/tools/core/inputSchema.ts`): `withDecodingDefault` alone lets an explicit `null` through.
- **Design for the model's first call.** A parameter with an obvious default is optional, with the default applied at dispatch; a required parameter models routinely omit is a tool bug. When a description enumerates dispatch behavior, keep it in step with the dispatch table.
