---
created: 2026-10-02
status: proposed
---

# Splitting the harness from TeXRA: three packages, TeXRA as an example app

Baseline: `main` at `85ef1f3765` (includes H3's two merged halves, #13635 and
#13637, and GUI lane G3, #13636). File counts are production `.ts`/`.tsx`
files, tests excluded; line references point into that tree. "The durable
doc" is [`2026-10-02-durable-harness.md`](./2026-10-02-durable-harness.md);
"the codemode doc" is
[`2026-10-01-codemode-everywhere.md`](./2026-10-01-codemode-everywhere.md).

This is a design. No code moves in the PR that carries it.

## Summary

The owner wants the everything-as-a-plugin agent core as its own package,
written in Effect throughout, with TeXRA as an app built on it, and wants it
before 1.0 (2026-10-01, 2026-10-02). The durable doc drew the boundary as
an import graph and deferred the physical split until after the freeze. This
note moves the split before the freeze and says how to do it.

There are three packages:

| Package             | Path               | Owns                                                                                                                                                                                                              | Files today |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `@texra-ai/harness` | `packages/harness` | The run's history, the loop, sessions and storage, the Registry and Step, the ports, the binding of a run's model choice to settings, trust, MCP and data plugins, the built-in plugins, the transcript row model | about 520   |
| `@texra-ai/llm`     | `packages/llm`     | Model access: the turn contract, the model catalog and routing, providers, the wire protocols behind one binder, subscription sign-in. Settings and credentials arrive as inputs                                  | about 75    |
| `@texra-ai/texra`   | `packages/texra`   | The app plugins, the documents plugin (round mode), LaTeX, the UI kit, the app's settings rows, the host-side controllers, telemetry                                                                              | about 300   |

The three hosts (`packages/cli`, `packages/desktop`, `packages/extension`)
and `packages/trace-viewer` stay separate packages. They are TeXRA products
and depend on both `@texra-ai/harness` and `@texra-ai/texra`. Dependencies
point one way: app → harness → llm, and `llm` depends on nothing in the
repo.

Most of the boundary is already clear. H3 removed the table import, the
`bibPath` field, the LaTeX types and the setting read from the kernel. A
fresh scan of the tree at `85ef1f3765` still finds 37 harness files that
import app code. Most of those imports are a type or constant filed in the
wrong directory. Five are real couplings, and this note fixes each of them:
round mode, the composition root's option bag, the closed service unions,
two app row kinds, and `write_file`'s LaTeX filter.

**Owner rulings, 2026-10-02.** (1) "Ledger" is renamed "history"
everywhere: `RunLedger` becomes `RunHistory`, after the core-concepts
History primitive (§6, M5). (2) Model access (the catalog, providers,
routing and sign-in) moves into `@texra-ai/llm`. `llm` reads no TeXRA
setting and imports nothing in the repo; configuration and credentials are
inputs (§1, M4). Its entry points are designed from TeXRA's own consumers,
not copied from a peer's. (3) The doc calls the owner "the owner" or
"they".

## 1. The three packages

### Directory map

| Today                                                                     | Files                 | To `@texra-ai/harness`                                                                                                                                                                                                                              | To `@texra-ai/texra`                                                                                                                                                                      |
| ------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent`                                                               | 153                   | ≈127: `core/`, `runtime/` without `loop/rounds.ts`, `followUp/`, `trace/`, `prompt/`, `storage/`, `codeSandbox/`, `index/` (agent catalog), `templates/`, `workspaceAgents/`, `debug/`, `export/schemas.ts` (the conversation format storage reads) | ≈26: `output/` (17, the documents plugin), `runtime/loop/rounds.ts`, `export/` formatters (chat export to LaTeX and Markdown)                                                             |
| `src/tools`                                                               | 175                   | ≈93: the engine (`liveRegistry`, `liveTools`, `toolTable`, `serverHolds`, `pluginLayers`, `pluginArms`, `catalogEntries`, `core/`, `approval/`, `mcp/`, `support/`, probes) and the built-in plugins in §3                                          | ≈82: `registry.ts` and `pluginManifest.ts` (TeXRA's binding), the app plugins in §3, `approval/latexPreview.ts`                                                                           |
| `src/shared`                                                              | 171                   | ≈123 (5 more, the provider catalog, go to `@texra-ai/llm`): `session/`, the core arms of `schemas/`, `state/` (harness rows only, §4), `tools/`, `runs/`, `plugins/`, `model/`, `config/`, `utils/`                                                 | ≈43: `settingsView/`, `commands/`, `launcher/`, `litControllers/`, `monaco/`, `highlighting/`, the LaTeX constants, `schemas/output.ts` and `schemas/inquiry.ts`, the webview host bridge |
| `src/controllers`                                                         | 73                    | ≈21: `session/` without the host-side modules                                                                                                                                                                                                       | ≈52: `mainView/`, `modelAccess/`, `onboarding/`, `progressView/`, `settingsView/`, `approval/`, and the host-side `session/` modules (§5)                                                 |
| `src/common`                                                              | 35                    | 33: errors, files, parsing, `plugins/` (trust, install record, MCP servers, hooks), secrets, storage                                                                                                                                                | 2: `teams/`                                                                                                                                                                               |
| `src/utils`                                                               | 60                    | 58                                                                                                                                                                                                                                                  | 2: the LaTeX dependency checks in `system/`                                                                                                                                               |
| `src/platform`                                                            | 20                    | 20: the ports at `.`, `defaults/` behind `./node`                                                                                                                                                                                                   |                                                                                                                                                                                           |
| `src/model`, `src/auth`                                                   | 16, 29                | 6: the binding (below). The other 37, `src/auth` and 8 of `src/model`, go to `@texra-ai/llm`                                                                                                                                                        | 2, with `setup`: `setupCredentialAccess`, `setupModelDefaults`                                                                                                                            |
| `src/skills`, `src/transcript`, `src/logger`, `src/eventBus`, `src/hosts` | 6, 6, 5, 1, 1         | All                                                                                                                                                                                                                                                 |                                                                                                                                                                                           |
| `src/ui`                                                                  | 59                    | 7: `transcript/`, which becomes `transcript/rows/` under `@transcript/*`                                                                                                                                                                            | 52: `wa/`, `styles/`, `markdown/`, `copy/`, `formatting/`                                                                                                                                 |
| `src/latex`, `src/replacement`, `src/telemetry`, `src/housekeeping`       | 30, 8, 3, 5           |                                                                                                                                                                                                                                                     | All                                                                                                                                                                                       |
| `packages/agent`                                                          | 7                     | Becomes `packages/harness`'s entry files                                                                                                                                                                                                            |                                                                                                                                                                                           |
| `src/test-kernel`                                                         | 515 tests and helpers | Stays one tree at the repo root; ratchets re-keyed to the new paths                                                                                                                                                                                 |                                                                                                                                                                                           |

The agent YAMLs, skills and plugin resources in
`packages/extension/resources/` are app data and stay there. The desktop
(`electron-builder.yml:41`) and the CLI (`packages/cli/scripts/copy-resources.mjs:8`)
copy them from there, and `vsce` packs only the extension's own directory.
The one harness resource, the `agent` plugin's skills in
`resources/plugins/workflow-script/`, moves to `packages/harness/resources/`,
which the three hosts also copy.

### Where the UI toolkit goes

`src/ui` splits. The transcript row model (`src/ui/transcript/`, 7 files,
2,454 lines) goes to the harness, because it is part of the session view:
`sessionFold.ts:83`, `sessionView.ts:51`, `transcriptState.ts`,
`transcriptReads.ts` and `transcriptFold.ts:30` import it, and the SDK's
`TranscriptView` rows are `TranscriptRow`. Its import of
`@ui/copy/workflowCall` (the tally text it prints) moves with it, so the
split is 8 harness and 51 app. Only the generic row and fold contract goes:
the app-specific presentation stays app code and is contributed through the
row model's extension point. That is `toolRowSections.ts`'s five Codex card
builders and the Codex schemas they import, and the `latexdiff` row in
`projectTranscriptRow.ts` and `TranscriptRow`. M3 splits them out before the
move, so the harness's row model imports no app schema. The kit,
styles, markdown and KaTeX, and copy tables go to the app. Their only
harness consumers are four misplaced imports (icon names in
`agentPresets.ts` and `todoDisplay.ts`, account copy in
`quotaFallbackRoutes.ts` and `modelRoutes.ts:40`), which move in M3.

### Model access goes to `@texra-ai/llm` (ruling 2)

`src/auth` (29 files: the ChatGPT and Grok sign-in flows) moves to `llm`,
with 8 files of `src/model` (`apiProviders`, the pure half of `modelRoute`,
`routeEndpoint`, `openRouterRouting`, `providerCapabilities`,
`reasoningChoice`, `modelOptionsBasic`, `subscriptionAccessOverrides`) and
5 of the provider catalog in `src/shared` (`constants/providers.ts`, the
data of `modelProviderPlugins.ts`, `modelSelection.ts`,
`kimiCodeRetryGate.ts`, `codingPlanSubscriptions.ts`), with the route and
provider-error schemas they return. Two of those files carry TeXRA
configuration today: `modelProviderPlugins.ts` imports `GlobalStateKey` and
`ModelCompatibilityKey` and embeds the Models tab's setting keys and control
copy, and `codingPlanSubscriptions.ts` imports `GlobalStateKey`, `UsageRoute`
and `ExhaustionReason` and carries CLI and setup presentation. M4 splits
each first: the pure provider and routing facts move to `llm`, and the
setting descriptors, control copy and presentation stay in the harness (and
the app, for the CLI and setup text), so `llm` imports no setting enum
before M7 splits them. `llm` gains `llm-zoo`, and it still
imports nothing in the repo; an ESLint zone with no baseline holds that
from M4.

`llm` defines one port, **`CredentialStore`** (`get`, `set`, `delete` of a
named secret). It is today's `SessionSecretStore` (`sessionAccess.ts:20`)
widened to API keys, and the harness serves it from `Secrets`, secret then
environment, as `resolveCredential` does. HTTP is Effect's own
`HttpClient`, which sign-in already requires
(`SubscriptionOAuthCoordinator.ts:33`); the harness provides the layer.
The rest is data: `RouteFacts` (`modelRoute.ts:65`) gains the fields `llm`
reads from settings today, and `openBrowser` is already an option
(`loopbackLogin.ts:66`).

| Read today (file:line)                                                                                                                                                               | Becomes                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRoute.ts:309-389` `readRouteFacts`: the OpenRouter, Kimi Code and GLM toggles and the GLM endpoint (`:347-350`), subscription preferences (`:323`), the Kimi Code key (`:353`) | Stays in the harness beside its caller, `runtime/modelRoutes.ts`, and returns `RouteFacts`. `decideModelRoute` (`:151`) is already pure                                                                    |
| `modelRoute.ts:405`: `routeConfig` reads the ChatGPT context-window setting                                                                                                          | `RouteFacts.chatgptContextWindow`                                                                                                                                                                          |
| `routeEndpoint.ts:48`: the custom provider endpoint; the region toggles, which `modelProviderPlugins.ts:28` names as `GlobalStateKey`s                                               | `RouteFacts.endpoints` (provider to URL), resolved by the harness. The toggle's key and control copy stay a harness setting row                                                                            |
| `apiProviders.ts:111-130`: key lookups over `PlatformSecrets` (`:8-14`); `sessionAccess.ts:11, :37-40`: `SecretsFailed` and the session store                                        | `CredentialStore`                                                                                                                                                                                          |
| `SubscriptionOAuthCoordinator.ts:18-20`, `sessionAccess.ts:10`: `safeParseJson`, `withLogChannel`, `SharedAttempt`                                                                   | `Effect.try` over `JSON.parse`; `Effect.annotateLogs` with the same `channel` key; `SharedAttempt` (63 lines) moves into `llm`, and its other caller (`SubscriptionUsageService`) imports it from `./node` |

`RouteFacts`, `ModelRoute` and `decideModelRoute` move to `llm` without
`CopilotModelRoute`, which is built from the host `LanguageModel` types. The
harness's `runModelDecision` widens the result to `ModelRoute |
CopilotModelRoute` where it adapts the Context-provided capability.

**What stays in the harness** is the binding of a run's model choice to
the session's settings: `readRouteFacts`, `runModelDecision`, and the
picker and preference state in `computeModelOptions` (`MODEL_SELECTION`,
`:524`, `:562`, `:684`), `copilotRouting` (`:124`, `:154`; Copilot is a
host route), `reasoningLevel` (`:30`), `subscriptionAccess` (`:52`, `:77`)
and `codingPlanSubscriptions` (`:40`). `setupCredentialAccess` and
`setupModelDefaults` go to the app with `setup`.

### The `llm` entry points

The entry points follow the harness's own convention (`.`, `./schemas`,
`./node`): a package is split by where its code runs, not by topic. Three
facts about today's consumers decide the shape.

- **`./turn` is imported everywhere, including the browser.** 34 files (22
  production, 12 tests) import it. The webview frontends and the desktop
  renderer reach it through the `LanguageModel` port type
  (`platform/languageModel.ts` → `processRuntime.ts` →
  `webviewSessionLayer.ts` → `progressView/frontend/sessionTransport.ts`),
  and the settings webview already imports `llm-zoo` and the provider
  catalog (`settingsState.ts`, `ProviderKeyList.ts`, `ModelSelectionList.ts`).
  Its graph today is `zod`, `effect` and three local modules, so it is
  browser-safe.
- **The wire protocols have one production caller.** `modelBinding.ts:16-22`
  is the only production file that imports `./openai-responses`,
  `./anthropic-messages`, `./google-interactions` or `./openrouter-chat`;
  the other four importers are their suites in `src/test-kernel/llm/`. The
  four subpaths exist only so that one import does not load every vendor
  SDK. A choice of protocol per route, made in one place, is better served
  by one function.
- **The prefix fingerprint is internal.** `./prefix-fingerprint` has no
  production importer; its two importers are the OpenAI Responses and
  Google Interactions suites. It uses `node:crypto`'s `hash`, as
  `uploadCache.ts` does, so it cannot sit in a browser-safe entry anyway.
  The schema field it fills (`message.ts:416`) is a plain string and stays
  in `.`.

| `@texra-ai/llm` entry | Contents                                                                                                                                                                                                                           | Runs in      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `.`                   | `Model`, the turn types and schemas (today's `./turn`), the model catalog over `llm-zoo` and the provider data, `RouteFacts`, `decideModelRoute`, `routeConfig`, the reasoning choice, the `CredentialStore` port type, the errors | browser-safe |
| `./node`              | `bindModel(route, facts, { credentials, fetch }) → Effect<Model, BindError, Scope>`, the ChatGPT and Grok sign-in flows, their coordinators and session schemas, `SharedAttempt`                                                   | Node         |

**The protocols become internal modules.** `packages/llm/src/api/` holds
the four protocols, the fingerprint and the upload cache, and nothing
exports them. `bindModel` moves the protocol choice out of
`modelBinding.ts` (`:437`, `:532`, `:568`, `:600`, `:945`) and loads the
chosen module with a literal `import('./api/<protocol>.js')`, so a run
loads only its provider's SDK. The harness's binding keeps what it owns
today: the route's price, context window and retry-gate keys, the Copilot
host route, and the long-running fetch (proxy handling, the 30-minute stream
and 10-minute header timeouts), which it passes to `bindModel` as `fetch` for
the protocols to hand their SDKs. Nothing
in `bindModel`'s signature names a protocol module's type
(`modelBinding.ts:210`'s `typeof openaiResponsesWebSocketModel` moves
inside `llm`), so the declaration graph of `./node` stays free of vendor
types too.

**Every host bundles the dynamic import.** esbuild rewrites `import()`
only when the specifier is a string literal (the note in
`externalBinaryUtils.ts:16-19`), which each protocol's import is.

- _Extension_ (`esbuild.config.mjs`: CJS, no splitting): the module is
  inlined behind a lazy initializer, so the SDK is bundled but evaluated
  on first use. `codexImport.ts:79` and `claudeAgentImport.ts:60` already
  ship this way.
- _Desktop main_ (`esbuild.main.mjs:53-54`: ESM, `splitting: true`): each
  protocol becomes its own chunk.
- _CLI_ (`build-bundle.mjs:43-44`: ESM, no splitting): inlined, as in the
  extension.
- _SDK_ (`packages/agent/scripts/bundle.mjs`: ESM, `splitting: true`,
  `packages: 'external'`): each protocol becomes a chunk, and the vendor
  SDKs other than the patched `openai` stay bare imports inside that
  chunk. The `bundle-workspace-llm` plugin resolves `@texra-ai/llm` and
  `@texra-ai/llm/node` through `import.meta.resolve`, which reads the new
  `exports`.

**What keeps `.` browser-safe.** Two checks, both existing machinery. An
ESLint `no-restricted-imports` block on `packages/llm/src/**` outside
`api/`, `oauth/` and `node.ts` forbids `node:*` and the four vendor SDKs,
with no baseline. The SDK's `validate-artifacts.mjs` already fails any
published entry whose declaration graph imports `@anthropic-ai/sdk`,
`@google/genai`, `@openrouter/sdk` or `openai`; it covers `.` and `./node`
unchanged. The renderer has no `@types/node`, so a Node type that reaches
`.` shows up as a `process` or `NodeJS` error in its typecheck; the fix is
at the import, never a Node type in the renderer.

pi's `pi-ai` exports topic subpaths (`./models`, `./providers/*`,
`./api/*`, `./oauth`). TeXRA splits by runtime instead, because its webviews
need the catalog and the turn types and must not reach a Node module, and
because its protocols have one caller.

## 2. The harness public API

### Services and layers

All of these exist today except where marked. The names keep the SDK's
current ones (`packages/agent/src/effect/sessions.ts`).

```ts
class Sessions extends Context.Service<
  Sessions,
  {
    open(roots?: WorkspaceRoots): Effect<Session, SessionOpenError>;
    close(roots?: WorkspaceRoots): Effect<SessionCloseReport>;
    list: Effect<readonly Session[]>;
  }
>() {
  static layer(input: {
    platform: AgentPlatform;
    plugins: readonly Plugin[];
    execution?: (
      roots: WorkspaceRoots,
    ) => Layer<WorkspaceFs | ChildProcessSpawner>; // new (H4, in M2)
    usageLog?: Layer<UsageLog, never, HarnessServices>; // new (M2): provided inside the layer; the SDK defaults to disabled
    host?: Layer<HostServices>; // new (M2): what a host serves its plugins
  }): Layer<Sessions | Plugins, PlatformConflict | PluginConflict>; // plugins, host: new (M2)
}
interface Session {
  roots: WorkspaceRoots;
  start(input: StartInput): Effect<Run, LaunchError | RunFailure>;
  resume(runId: RunId): Effect<Run, LaunchError | RunFailure>; // new (H4, in M2)
  request(r: RuntimeRequest): Effect<Outcome, RequestError>;
  view: { changes: Stream<SessionView> };
  subscribe(i: readonly TranscriptSubscription[]): Effect<void, never, Scope>;
}
// Run { runId, result, view, events, interrupt }: unchanged
class Plugins extends Context.Service<
  Plugins,
  {
    contribute(p: Plugin): Effect<void, PluginConflict, Scope>; // new (H4, in M2)
  }
>() {}
```

Most ports are fields of `AgentPlatform` (`runtime.ts:50`); the execution
environment and the host's layers are `Sessions.layer` inputs, because they
are replaced per embedder and have no default in the platform. Each is served
as an Effect service:

| Port          | Platform field                                          | Service                                                                                                                               |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Storage       | `roots` (storage paths)                                 | `GlobalDatabase`, `ProjectDatabases`; `RunHistory` internal                                                                           |
| Models        | `languageModel`, `secrets`                              | `LanguageModel`, `Secrets`; reads settings into `RouteFacts`, serves `llm` its `CredentialStore` and `HttpClient`, gets a `Model`     |
| Settings      | `roots.config`, the state stores                        | `AppState`, `ConfigProvider`                                                                                                          |
| Execution env | (none: `execution` input, keyed by the session's roots) | `WorkspaceFs` + `ChildProcessSpawner`, replaced together, per run after H4; the Node pair from `./node` is the default                |
| Sandbox       | (none)                                                  | `CodeSandbox`, the `codemode` plugin's session layer                                                                                  |
| Agents        | `agentDirectories`                                      | `AgentDirectories`                                                                                                                    |
| Usage         | (none: `usageLog` input)                                | `UsageLog`, disabled in the SDK; the three hosts pass the app's `src/telemetry` layer, so usage reporting and its shutdown drain stay |

`mcpConfigPath` stays a platform field. The installed-plugin reader and the
MCP loader are harness machinery, not a plugin value. `host` carries what a
host supplies to its plugins and the app cannot import: the extension's Lean,
inline-comment and Copilot providers. A plugin requires them as ordinary
services, and `H`, the host requirement, is a generic threaded through
`definePlugin`, the plugin's layers and tools. The harness never names an
app tag; the host's `Layer<HostServices>` must provide every `H` its roster
declares, which `Sessions.layer` checks at the type level. A session layer
may consume the plugin's own process output (`POut`), which the step
provides before building it.

**Per-root execution.** `execution` is a function of the session's roots,
called at `Session.open(roots)`, so a sandboxed filesystem and spawner are
built per workspace; `WorkspaceFs` is constructed from them for each
session's roots.

**Roster identity.** `acquireProcess` joins an installed process only when
every process input is the same: the platform, the initial plugin list, and
the `host` and `usageLog` layers (by reference). `execution` is applied per
session and is part of the identity too. A second
`Sessions.layer` with the same platform and a different list fails with
`PluginConflict`, reason `roster`, so the first acquisition never decides
another consumer's plugins. Each `Plugins.contribute` withdraws only what it
contributed, when its scope closes.

### The extend half: `Plugin`

The durable doc's sketch, made precise so that it can replace the manifest
and the five `satisfies` tables (`registry.ts:156-283`) and the manifest
flags that point into them (`plugins.ts:60-110`):

```ts
interface Plugin<POut = never, SOut = never, H = never, ROut = POut | SOut> {
  readonly id: PluginId;
  readonly revision: string; // 'builtin' for first-party
  readonly requires?: readonly PluginId[]; // first-party only (below)
  readonly tools?: readonly Tool<HarnessServices | H | ROut>[]; // defineTool(...)
  readonly prompt?: PromptSection;
  readonly continuation?: Continuation<ROut>;
  readonly rounds?: RoundPolicy<ROut>; // per agent category (M1)
  readonly arms?: readonly PluginArm[]; // plugin.fact kinds, versioned
  readonly settings?: readonly SettingRow[]; // §4
  readonly availability?: Availability; // probes → blocked reasons
  readonly meta?: PluginMeta; // below
  readonly requests?: readonly PluginRequest[]; // durable request kinds, §4
  readonly project?: PluginProjection<ROut>; // read side of its arms, §4
  readonly runConfig?: PluginRunConfig; // versioned schema and upcasters, §4
  readonly drain?: Effect<void, never, HarnessServices | POut>; // process output only
  readonly processLayer?: Layer<POut, never, HarnessServices | H>;
  readonly sessionLayer?: Layer<
    SOut,
    never,
    HarnessServices | H | POut | SessionServices
  >;
  readonly agents?: string; // directories, as data
  readonly skills?: string;
}
declare const definePlugin: <POut, SOut, H>(
  plugin: Plugin<POut, SOut, H>,
) => Plugin.Any;
```

- **Operational metadata stays.** `Plugin` replaces the manifest's tables
  and pointers, not what the product does with them. `PluginMeta` keeps
  `toggleable` and `onByDefault` (which seed `toolAvailability.ts`),
  `injectedWhen` (automatic tools, `agentToolResolution.ts`), the display
  and host-visibility fields (`ToolDashboardData`) and the setup and sign-in
  steps the CLI install flow reads. M2 moves each field and deletes no
  behavior.
- **Drain.** `drain` replaces `ProcessPluginLayer.drain`. `drainPlugins`
  runs every plugin's `drain` before sessions close, so a delivery already
  admitted (the GitHub poller's) finishes writing to its session. A layer
  finalizer cannot express that order.
- **State.** A plugin reads and appends its own arms through `PluginState`
  (`read(arm, key?)`, `commit(arm, value, { key?, parent? })`, where `key`
  names the plugin aggregate, one per inquiry thread, and `parent` is the
  run edge supplied when a thread opens or reopens; the `transition` check
  below receives both), exported from `.` and scoped to the
  plugin's declared arms. It wraps `SessionHandle.runView` and `commit`,
  which stay internal, so `goal` and the app's plugins need no deep import.
- **Process and session outputs.** `drain` runs once against the process
  layer's context, so it may require only the process output (`POut`); the
  session output (`SOut`) is tracked separately, and a drain that asks for a
  per-session service fails to compile.
- **Typed requirements.** `definePlugin` checks at compile time that every
  tool, continuation and round policy needs only harness services and what
  the plugin's own layers add. The Registry stores the erased value, and the
  step provides the pinned layers. This replaces the closed
  `PluginServices` union (`processRuntime.ts:97`) and the app tags in
  `ProcessServices` (`:68`: `InquiryRecords`, `UpdateCheckRecords`,
  `SetupPlatform`, `LeanLanguageServices`).
- **Options, not hooks.** Where the app changes a built-in, the built-in
  takes options, as `agentTool(options)` (#13637) carries TeXRA's figure
  fields. `fileOps({ writeFilter })` does the same for the `.tex`
  replacement in `write_file` (`WriteTool.ts:48-55`).
- **Contribute in a `Scope`.** `Plugins.contribute` is `Registry.contribute`
  for each of the plugin's maps under one scope, as the durable doc says.
  `settings`, `agents` and `skills` follow the same registry generations as
  tools: the settings catalog, the agent catalog follower and the skill
  roots rebuild when a generation changes, and withdrawing a plugin removes
  its rows, agents and skills.
- **Dependencies.** An agent's dependencies are derived from its tool list and from the
  plugin that supplies the round policy of its category, so a workflow agent
  with no tools still depends on `documents`; an agent may also name an
  owning plugin.
  A hard `requires` is for first-party values only: resolved at
  `Step.open`, transitive, and a cycle is refused when the plugin set is
  built (`PluginConflict`, reason `cycle`). Nothing turns a required plugin
  on automatically, and there are no version ranges or lockfile. An unmet
  dependency yields one typed blocked reason, `{ kind: 'pluginOff' |
'pluginUntrusted' | 'missingBinary' | 'missingCredential', plugin }`, beside
  the GUI doc's `agentMissing`, held in the projection (durable D5).
- **Trust.** A first-party value is trusted by construction
  (`revision: 'builtin'`). Third-party plugins stay data, MCP and hooks
  (ruling Q1), trusted per content digest (`pluginTrust.ts`) through a
  `request.opened` row answered by `Session.request`.

### Subpath exports

| Subpath        | Contents                                                                                                                                                     | Runs in      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `.`            | `Sessions`, `Session`, `Run`, `Plugins`, `PluginState`, `Plugin`, `definePlugin`, `defineTool`, the errors, the port types                                   | any          |
| `./plugins`    | The built-in plugin values of §3, `fileOps(options)` and `agent(options)` included, and two lists: `harnessBuiltins.minimal` and `.all`                      | any          |
| `./schemas`    | Agent config and run-end schemas (exists; the four document flags of `ToolConfigSchema` are not in it, see below), `SessionEvent`, `PluginArm`, `SettingRow` | browser-safe |
| `./transcript` | The row model and its projections, for renderers                                                                                                             | browser-safe |
| `./node`       | `nodePlatform`, the SQLite store, the Node spawner, the code-sandbox worker asset                                                                            | Node         |

`./schemas` and `./transcript` exist because the webview frontends cannot
load `.`. A `./testing` subpath waits for a named external consumer. There
is **no Promise API**: the hosts and the trace viewer are Effect at their
entry points (ruling of 2026-09-21, quoted in `packages/agent/src/index.ts`).

### Today's deep imports: public or internal

| Specifier (today)                                                                                                                                                                                                                   | Becomes                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `@agent/core/definition/AgentConfig`, `AgentDataclass`, `@agent/runtime/RunEndResult`                                                                                                                                               | public, `./schemas` (already)                                   |
| `@agent/core/tools/ToolTypes` (`ITool`, `ToolGuard`), `@tools/core/definition` (`defineTool`), `@agent/trace` (`AgentEvent`)                                                                                                        | public, `.`                                                     |
| `@shared/session/{runtimeRequest,requestErrors,database}` (request, outcome and open errors), `@shared/session/sessionView` (types)                                                                                                 | public, `.`                                                     |
| `@platform/{interfaces,secrets,languageModel,workspaceRoots}` port types; `@platform/defaults/*`                                                                                                                                    | public, `.` and `./node`                                        |
| `@tools/toolTable` (`Continuation`, `PromptSection`), `@tools/pluginArms` (`PluginArm`)                                                                                                                                             | public, through `Plugin`                                        |
| `@agent/runtime` barrel (`closeAllSessions`, `installedProcessRuntime`), `@agent/runtime/loop/*`, `ModelInvoker`, `RunHistory`, `SessionEvents`, the folds, `storeSchema`, `rowCodec`, `liveRegistry`, `liveTools`, `codeSandbox/*` | internal                                                        |
| `@agent/index`, `@agent/storage`, `@agent/followUp`, `@agent/export` (the hosts' five, `host-agent-import-baseline.json`)                                                                                                           | internal; hosts reach them through `Session` and `request` (M9) |

## 3. Built-in plugins and app plugins

| Plugin (id today)                                    | Tools                                                                        | Goes to      | Reason                                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-ops`                                           | `bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`               | harness      | Every agent needs files and a shell. The `.tex` replacement becomes an option the app passes                                                                |
| `web`                                                | `web_search`, `web_fetch`                                                    | harness      | General                                                                                                                                                     |
| `memory-workflow`                                    | `memory`, `todo_write`, `executions`                                         | harness      | General. `accept_run_files` leaves for `documents`: it accepts workflow outputs and imports `@latex/acceptedFileTarget` and `@replacement/advanced`         |
| `goal`                                               | `plan`, the continuation, the `goal/state` arm                               | harness      | A general continuation, and the reference case for plugin arms                                                                                              |
| `workflow-script` (contributes `agent`)              | `agent`                                                                      | harness      | Owned children are the durable contract (H1). TeXRA passes its figure options                                                                               |
| `codemode`                                           | `script`                                                                     | harness      | The one model-facing tool                                                                                                                                   |
| `core`, harness half                                 | `ask_user_question`                                                          | harness      | A durable request with no domain                                                                                                                            |
| MCP servers, installed Claude Code and Codex plugins | from data                                                                    | harness      | Data, hooks and trust are harness machinery                                                                                                                 |
| `core`, app half (becomes `texra`)                   | `inline_comment`, `open_pdf`, `lean_loogle`, the bibliography prompt section | app          | Review annotations, PDFs, Loogle and `.bib` are the theorist's                                                                                              |
| `documents` (new id)                                 | `accept_run_files`; round mode                                               | app          | Workflow agents are TeXRA's (durable doc, violation 4)                                                                                                      |
| `latex-extract`, `latex-diagnostics`, `texcount`     | extraction, diagnostics, word count                                          | app          | LaTeX                                                                                                                                                       |
| `arxiv`, `crossref`, `zotero`                        | papers and citations                                                         | app          | Papers                                                                                                                                                      |
| `lean4`, `wolfram`                                   | Lean language server, Wolfram                                                | app          | Domain tools                                                                                                                                                |
| `setup`                                              | the onboarding set                                                           | app          | It edits TeXRA's settings and calls VS Code commands                                                                                                        |
| `codex`, `claude-agent`                              | `codex`, `claude_code`                                                       | app          | Product integrations, 13 files: two vendor SDKs, binary and sign-in probes, their own session stores. They move to the harness when a second app needs them |
| `github-pr-subscription`                             | `github_subscription`                                                        | app          | 23 files and a polling service. It belongs to a software-engineering bundle, not the kernel                                                                 |
| `external-inquiry`                                   | `inquiry`                                                                    | app          | A human copy-and-paste flow for chat subscriptions, which is a product feature                                                                              |
| `copilot`                                            | from the host                                                                | VS Code host | A host layer, as today                                                                                                                                      |

The durable doc listed the last four as optional harness plugins. Here
they are app plugins, so the harness ships nothing that needs a vendor SDK
or a background service, and eight dependencies leave its `package.json`:
`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `arxiv-client`,
`@jamesgopsill/crossref-client`, `bibtex`, `identifiers-arxiv`,
`content-disposition` and `tar`.

## 4. Proving TeXRA is just an example

**The ratchet.** App and host files import the harness only through its
package name and subpaths, and the harness imports nothing from the app.
The second rule is an ESLint zone with no baseline, added in M8, the PR
that clears the last edge. The first is the existing set-based deep-import
ratchet, widened to count every harness-internal alias an app or host file
reaches, not only `@agent/*`: 254 distinct specifiers today (173 from the
hosts, 170 from the app, overlapping). It starts there, replaces
`host-agent-import-baseline.json` (18 entries, a subset), and only shrinks
(Q2).

**The manifest moves to the app.** `registry.ts` and `pluginManifest.ts`
become `packages/texra/src/plugins.ts`, a list of `definePlugin` values;
nothing in the harness names an app plugin. Each host passes
`[...harnessPlugins, ...texraPlugins]` to `Sessions.layer`, and the SDK's
`nodePlatform`, which binds TeXRA's table today (`runtime.ts:38`, `:190`),
passes only the built-ins.

**A minimal list is the harness's own example.** `./plugins` exports
`harnessBuiltins.minimal` (`fileOps()`: the shell and the file tools) beside
`harnessBuiltins.all`. A session over the minimal list is a complete
harness whose other tools are absent, not hidden: deepseek-harness's rule
for its minimal mode (`da00f7f535`), which it ships as a separate tree and
which here is one more array. It is the SDK's example and H6's
built-ins-only crash run. Lists stay TypeScript values, with no YAML
profiles or patch layers.

**One case pins each host's roster.** No suite pins it today: the golden
store's 17 `tools.offered` rows hold the fixture agents' declared tools,
and `pluginBoundaryRatchet.vitest.ts` checks imports. One case joins that
suite (`test:pure`) in M2. For each host's list and the minimal one, it
pins the plugin ids in order and the tool names a default agent offers the
model with every plugin on.

We don't copy deepseek-harness's four layers of YAML patching, its ~55
published package groups or its allowlist in place of a lint: its core
still leaked peer dependencies on its sandbox, approval and PTC packages.

**Settings layer by owner.** A setting row (today's `StateSettingEntry`) is
declared by its owner: the harness's rows (model, approvals, retries,
compaction, concurrency, skills, logging) in the harness, each plugin's on
its `Plugin` value, as the manifest's `settings` field already lists them.
The catalog is their concatenation, rebuilt per registry generation, and the
settings view and `texra config` read it. `stateSettings.ts` loses its two
app imports (`latexConfig`, `replacementCategories`), and the closed
`GlobalStateKey` and `WorkspaceStateKey` enums split by owner. Key strings
stay `texra.*`, so there is no new format and no migration.

**The hardest shared thing is the closed row union.** Two app kinds sit in
the harness's `SessionEvent` union and in its folds:

- `output.produced` (`sessionEvent.ts:323`), the documents plugin's round
  outputs. It is written once (`documentRounds.ts:490`), but its schema
  (`schemas/output.ts`, 347 lines) and the run's files reach about a dozen
  harness files: `sessionFold`, `sessionView`, `runRows`, `runRecords`,
  `progressEvents`, `agentConfig`, `fileFields`, the round-keyed sidecars in
  `runState.ts`, and the row model's `toolRowSections`.
- `inquiryThreadUpdated` (`:352`), with its own aggregate kind, `inquiry`
  (`:111`), and a special parent edge in `referencedAggregates` (`:497`).

Arms and projections follow the registry generation like the catalogs: a
generation that adds an arm re-decodes the session's `plugin.fact` rows that
were left out while it was absent and refolds open sessions, and one that
withdraws it drops the projection's slot only when the generation's last
run or session pin is released, so a run started under a scoped
contribution still commits its final fact and reads its result slot. Contribution is therefore safe for
stateful plugins. A plugin's arm may also declare a `transition(prev, next,
parent)` check, which the store runs inside the append transaction beside the
schema. The store reads the parent aggregate's state in the same transaction
(closed, owner) and passes it as `parent`, so a missing, closed or foreign
parent is refused generically for any non-null plugin parent; state machines (the inquiry's monotonic turns, one open turn, a
terminal drop, a valid reopen and reparenting) stay atomic and `PluginState`
carries no read-then-write race; it replaces `validateInquiryTransition`.

The same goes for run configuration: `ToolConfigSchema`'s four document
flags (`autoExtractFigure`, `autoExtractTikzFigure`, `attachTeXCount`,
`autoCompileInputPdf`) leave `AgentConfig` for a plugin-keyed config slot,
`config.plugins[id]`, validated by the owning plugin and persisted on
`run.config` as a versioned envelope `{ v, body }` that the harness stores
opaquely. `Plugin.runConfig` declares the schema, its version and the
upcasters, which the harness runs on validate and on resume, as `arms` does
for `plugin.fact`. M6 lands it with the slot. The documents
plugin declares them.

Both are the plugin's arms with their read side. `Plugin.requests` lets a
plugin contribute a durable `request.opened` kind and its decision: the
inquiry's `externalInquiry` permission payload and `answer` decision leave
`prompts.ts` and `RequestDecisionSchema` for a generic `plugin.request`
payload `{ plugin, kind, v, body }`, validated by the owning plugin.
`Plugin.project` folds a plugin's facts into `SessionView.plugins[id]`, which
replaces `SessionView.inquiries` (the `BackgroundTasksPanel` reads the
plugin's slot) and gives `Run.result` its documents: the harness's end
result stays generic, `WorkflowRunEndResult` and the helpers of
`schemas/output.ts` move to the app, and `executeAgent.ts` and
`runRecords.ts` read the documents slot instead of `roundOutputs`. The post-run
diff paths and the `diffsUnavailable` reason, which `withWorkflowDiffs` and
`storedResultMeta` write after delivery, become a second documents fact,
`documents/diffs` v1, appended once the diffs are computed, so a reopened
run rebuilds them. `selectAutoOpenFinalOutput.ts` (it reads
`texra.agentOutputs.autoOpenFinal`) and `subagentResults.ts` (it interprets
outputs, compile failures and diffs) move to the app in M3 and read the
slot. A stored run folds to the same slot, so reopening a session loses
nothing.

An arm declares its scope, `session` (the project database) or `global`
(the `GlobalDatabase`), and `PluginState` reads and appends it in that
store. The inquiry thread arm is `global`, as `InquiryRecords` is today, so a
follow-up from another project and an answer with the originating project
closed still reach the thread; the project's `plugin.fact` rows stay display
notifications for the session view.

Both become `plugin.fact` arms. `output.produced` becomes `documents/output`
v1: the listing already folds the latest value per (plugin, kind), and the
run's file list and the sidecars become the documents plugin's read of it.
`inquiryThreadUpdated` becomes `external-inquiry/thread`. The aggregate
kind `inquiry` becomes `plugin`, an aggregate a plugin owns and keys, and
`plugin.fact` gains a nullable `parent` run edge that `referencedAggregates`
reads in place of the special case. The harness then folds no app kind.
Both are row changes, so they land before the freeze (Q3).

## 5. Hosts

The CLI, the desktop app and the extension are TeXRA products, and nothing
in them moves into the harness. The Ink TUI kit stays in `packages/cli`.

- **Host runtime layer.** Hosts call `installProcessRuntime`
  (`sessionLayer.ts:1071`), and the SDK calls it through `acquireProcess`.
  That composition root stays in the harness but loses its app options
  (`setup`, `inlineComments`, `lean`, `toolAvailability`; `:1013-1028`) and
  the two app record layers (`:1099-1100`). They become the owning plugins'
  `processLayer`s, or `hostLayer`s where a host supplies them (the
  extension's Lean and inline-comment providers). A host then differs from
  the SDK only in its platform and its plugin list.
- **Host-side session controllers go to the app.** `hostRunActions` (708
  lines), `hostDraftRequests`, `hostSnapshotSource`, `sharedHostRequests`,
  `SessionBridge`, `attachSessionHost`, `webviewSessionLayer`,
  `hostCallFailure`, `workspaceFileOptions` and the two record modules serve
  TeXRA's three hosts, and import `mainView`, `progressView` and `teams`. A
  `./host` subpath would publish about 2,500 lines to no external consumer.
  Their deep imports join the ratchet's baseline, and each generic action
  (resume, stop, retry with a key, follow-up, fork after H5) shrinks it by
  becoming a `RuntimeRequest` arm (Q6).

## 6. Storage and the freeze

| Row kinds                                                                                                                                                                                                                                              | Owner after the split                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `run.*`, `child.*`, `request.*`, `approval.policy`, `followup.*`, `tool.*`, `script.call`, `tools.offered`, `model.*` and `context.edit` (H2), `context.*`, `hook.outcome`, `usage`, `log`, `stage.*`, `stream.*`, `response.finalized`, `plugin.fact` | harness                                                                               |
| `conversation.progress`                                                                                                                                                                                                                                | harness: the tool-call counter `executeAgent.ts:102` writes for every run             |
| `output.produced`                                                                                                                                                                                                                                      | documents → `plugin.fact` `documents/output` v1                                       |
| `inquiryThreadUpdated` and the `inquiry` aggregate kind                                                                                                                                                                                                | external-inquiry → `plugin.fact` `external-inquiry/thread` v1 on a `plugin` aggregate |
| `goal/state`                                                                                                                                                                                                                                           | goal (a harness built-in), unchanged                                                  |

The freeze then covers two version tables: the harness's `ROW_KINDS`
(`rowVersions.ts:41`, two entries shorter) and each plugin's own arms with
their versions (`PLUGIN_ARMS`, `pluginArms.ts`). A plugin evolves its arms
without a harness row version, as the core-concepts note requires. Plugin
ids appear in stored rows (`tools.offered`, `plugin.fact`), so the id
changes (`core` split into `core` and `texra`, `memory-workflow` losing
`accept_run_files`, new `documents`) belong to the same pre-freeze step.

**Order.** The row split (M6) comes before the freeze. The move (M8)
changes no stored shape; Q5 asks whether it must hold the freeze too.

### The run's history (ruling 1)

Four files are renamed: `runLedger.ts`, `RunLedger.ts`, `runLedgerEvent.ts`
and `ledgerTurns.ts` become `runHistory.ts`, `RunHistory.ts`,
`runHistoryEvent.ts` and `historyTurns.ts`. Code holds 576 occurrences in
106 files (363 production, 213 test): 300 in 15 identifiers (`RunLedger` 83,
`RunLedgerDraft` 67, `RunLedgerRefused` 42, …) and 267 in comments and
strings. Prose holds about 540 in 65 Markdown files: CLAUDE.md and
AGENTS.md (5 each), 56 under `.agents/docs`, and one published line
(`docs/guide/multi-agent-workflows.md:92`). About 1,100 in all. Two other
ledgers keep their names: the architecture rulings ledger (its file name,
26 path references, "ledger residents") and the Lean plugin's
`tactic-ledger` (45). No table, row kind, column or setting is named for
it, so no format bump.

The name stays unambiguous with one rule. Bare "history" is the
core-concepts History, the session's rows; the run's history is one run
aggregate's slice of it, always qualified (`RunHistory`, `runHistory`),
never a bare `History` identifier, and `History.writer` stays unbuilt.
`SessionHandle.ledger` becomes `runHistory`, beside the existing
`history: HistoryQuery` (`SessionHandle.ts:300`, the `executions` tool's SQL
over the session's display rows), which keeps its name. So do
`input_history` (prompt recall) and `texra history` (stored runs).

## 7. Migration plan

Each step is one PR (owner: bigger PRs). M4 moves files into the existing
`packages/llm` and M5 renames four; no other step before M8 moves a file,
so they rebase cleanly against the running lanes. No step leaves a shim, a
re-export or a forwarding module; a moved symbol's importers are rewritten
in the same PR.

| Step | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Size                              | Depends on             | Freeze |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------- | ------ |
| M1   | Round mode becomes the documents plugin's `rounds` contribution, keyed by category and read once at run open (`toolUse.ts:143-144` loses the category branch; `rounds.ts:127-142` loses `makeDocumentRounds`). This is H3's remaining violation, 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | M, ~15 files                      | none                   | no     |
| M2   | `Plugin`, `definePlugin`, `Sessions.layer({ platform, plugins })`, `Plugins.contribute`, `Session.resume`, and the spawner moved onto the run layer (H4, absorbed). The manifest and its five tables become plugin values. The composition root loses its app options and record layers, and `ProcessServices`/`PluginServices` lose their app tags. The SDK stops binding TeXRA's table. `harnessBuiltins.minimal` and `.all`, and the roster case (§4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | L, ~60 files, net deletion        | M1                     | no     |
| M3   | The remaining harness→app imports. Misplaced types and constants move to their owners: `ToolCategory` and the other types out of `settingsViewMessages` (6 importers), `workflowOutput`, icon names, account copy, `teams`, `latexToolchain`. `fileOps({ writeFilter })`; `accept_run_files` moves to `documents`; `SessionRequests` stops importing `inquiryActions`. `selectAutoOpenFinalOutput.ts` and `subagentResults.ts` move to the app. `pluginAvailability.ts` dissolves into per-plugin `availability` values, and `toolProbes.ts` stops importing the app's LaTeX dependency checks. The Codex and `latexdiff` row builders split from the row model, and `LATEXDIFF` and `parseDiffResultEntries` leave `schemas/log.ts` and `logPayload.ts` for the app, which contributes a log-payload decoder beside its row presentation (the harness decodes an unknown log kind as opaque, loudly). The host-side session modules are marked for the app | M, ~40 files                      | M2                     | no     |
| M4   | Model access into `@texra-ai/llm` (ruling 2): `git mv` of `src/auth` (29), 8 `src/model` files and the 5 provider-catalog files into `packages/llm/src/{models,providers,api,oauth}`; `CredentialStore` defined in `llm` and served from `Secrets`; `RouteFacts` gains `endpoints` and `chatgptContextWindow`; the entries of §1: the 34 `./turn` importers rewritten to `.`, the protocol choice moved from `modelBinding.ts` into `bindModel` in `./node` with the protocols, the fingerprint and the upload cache under `src/api/` and unexported, today's six subpaths deleted, and the four suites in `src/test-kernel/llm/` reaching `packages/llm/src/api/` by relative path, as `test-live/` does; the moved files' importers rewritten to `.` or `./node` and the `@auth/*` alias deleted; `llm` gains `llm-zoo`; the llm-imports-nothing zone and the browser-safe `.` rule, no baseline                                                          | M, ~45 files moved, ~70 importers | none                   | no     |
| M5   | "Ledger" becomes "history" (ruling 1): the four files of §6 and every occurrence, about 1,100 in about 170 files, CLAUDE.md, AGENTS.md and `.agents/docs` included; a codemod over a fixed word list that skips the rulings ledger and Lean's `tactic-ledger`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | S in review, M in files           | H1, H2 merged          | no     |
| M6   | Rows: the `documents/output` and `external-inquiry/thread` arms replace `output.produced` and `inquiryThreadUpdated`; the `plugin` aggregate kind and `plugin.fact.parent`; the plugin id changes; `Plugin.requests` and `Plugin.project` replace the inquiry request payload and `SessionView.inquiries`, and the documents result slot replaces `roundOutputs`. The golden store is regenerated once, with H1's if they land together                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | M, ~30 files                      | H2 (#13638) merged; M2 | before |
| M7   | The settings catalog by owner: harness rows, plugin rows on `Plugin`, the enums split                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M, ~25 files                      | M2; after G6           | no     |
| M8   | The move, rename only: `git mv` of about 520 files into `packages/harness/src` and about 300 into `packages/texra/src`; `packages/agent` becomes `packages/harness` (`@texra-ai/harness`); `tsconfig.json` paths retargeted; dependencies split; ESLint zones and ratchet paths re-keyed with identical entries; the harness-imports-no-app zone at zero; the widened deep-import ratchet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | L in files, S in review           | M1–M7, H1; G2 merged   | see Q5 |
| M9   | Shrink the deep-import baseline, one host per PR, through `Session.request` arms and public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | M each                            | M8                     | no     |

**Why M5 is not folded into M8.** M8 is reviewed by its shape: every entry
in `git diff -M` is a pure rename or a codemod's specifier rewrite. About
1,100 word changes would turn a hundred of those renames into edits to
read. M5 on its own lands early, so M6 to M8 are written in the new
vocabulary. M8's one documentation edit is the live guides: `CLAUDE.md` and
`AGENTS.md` (paths, the SDK boundary, the ratchet names) change in the same
PR, while historical proposals keep their baseline paths.

**Path aliases.** The alias names stay. `tsconfig.json` maps the harness's
aliases (`@agent/*`, `@shared/*`, `@tools/*`, `@controllers/*`, `@common/*`,
`@utils/*`, `@platform/*`, `@model/*` for the binding, `@skills/*`,
`@transcript/*`, `@logger/*`, `@eventBus/*`, `@hosts/*`) into
`packages/harness/src`; `scripts/aliases.mjs` derives the build aliases.
App files take `@texra/*`, and `@latex/*`, `@replacement/*`, `@telemetry/*`,
`@housekeeping/*` and `@ui/*` point into `packages/texra/src`. App files
that leave a mixed directory get their specifiers, and the ratchet's
baseline, rewritten by one codemod in M8.

**Ratchets only shrink.** `architecture-edges-baseline.json` loses every
harness→app pair in M1 to M3 and is re-keyed by package in M8 with no new
pair. `file-size-baseline`, `knip-baseline` and the effect-migration
allowlists are re-keyed by path in M8 with the same counts.
`host-agent-import-baseline.json` gives way to the wider ratchet, whose
starting set contains it. The `Effect.run*` door renames `agent` to
`harness`; `packages/texra` is a library and gets no door.

**Order against the running lanes.** H2 (#13638, open) merges first: it is
on the freeze's path, and M6 builds on its shapes. H1 follows. M1 to M4 can
start now, beside H1, G2, G3 and G6, which do not touch the plugin table,
the composition root or the model files (no open PR touches `src/model` or
`src/auth`), except G6's plugin list, which M2 rebases onto. M5 waits for
H1 and H2, which edit the four history files; it is mechanical, so if M6
is ready first, M5 rebases over it. M7 waits for G6, which rewrites the
Settings › Plugins rows. M8 waits for M1 to M7, H1 and G2 (which reworks
`src/ui/transcript/`), and lands before H5, G4 and G5 start, so that those
lanes never rebase across a move. H6's crash suite then runs twice, with
`harnessBuiltins.minimal` and with TeXRA's plugins: the end-to-end proof
that TeXRA is one plugin list among others.

**Build and packaging.**

- _VS Code contributions._ `scripts/sync-package-contributes.mjs` scans the
  harness resource root as well as the extension's, so the moved
  `workflow-script` skill stays in `contributes.chatSkills`, and emits the
  staged VSIX path. `verify-vsix-contents.mjs` maps and hashes the harness
  resource root as well as the extension's, so the staged skill is not an
  unexpected resource. M8 updates it, and `check:package-contributes` covers it.
- _Published harness._ `packages/harness/package.json` `files` includes
  `resources/`, and `nodePlatform` resolves the installed package's
  resource directory, so a packed harness advertises `workflow-script` with
  its skill.
- _Extension, desktop, CLI._ The bundles follow the aliases from
  `tsconfig.json`. `verify-vsix-contents.mjs` keys on `extension/resources/`,
  which does not move. The harness resources join each host's copy step
  (`electron-builder.yml:41`, `copy-resources.mjs`).
- _SDK._ M2 and M8 update `packages/agent/README.md` (installed and imported
  as `@texra-ai/harness` from M8, with the `Sessions.layer({ platform,
plugins })` example) and the SDK usage snippets; the code and its README
  change together. `packages/agent/scripts/` moves with the package; the declaration
  rewrite and `validate-artifacts.mjs` cover the new subpaths.
- _Code-sandbox worker._ `scripts/code-sandbox-worker.mjs` reads the new
  path, and the asset ships under `./node`.
- _Tests._ `src/test-kernel` imports through the same aliases, so the move
  changes no test. `dependencyDirection.vitest.ts` and
  `VSCODE_FREE_ZONE_DIRS` are re-keyed together.

## 8. Owner questions

1. **Names and paths.** `@texra-ai/harness` at `packages/harness`, renamed
   from `@texra-ai/agent`; `@texra-ai/llm` keeps its name; the app is
   `@texra-ai/texra` at `packages/texra` (the durable doc proposed
   `theorist`). _Recommend: yes._ The theorist is the first bundle inside
   the app, not the whole app.
2. **The deep-import ratchet starts at 254 and shrinks**, rather than M8
   making public every internal module an app or host file reaches.
   _Recommend: the baseline._ Publishing 254 modules would freeze the
   internals as API; M9 shrinks the count through `Session.request` arms.
3. **App rows become plugin arms before the freeze** (§4). _Recommend:
   yes._ It removes two kinds, adds none, and the harness folds no app
   state.
4. **Four plugins go to the app**, not the harness: `codex`,
   `claude-agent`, `github-pr-subscription`, `external-inquiry`.
   _Recommend: app._ They bring vendor SDKs or background services; any of
   them moves when a second app needs it.
5. **Which split gates the freeze**: the row split (M6) only, or the move
   (M8) too? _Recommend: M6 gates it, and M8 lands right after, before
   H5._ The move changes no stored byte.
6. **The host-side session controllers go to the app**, with no `./host`
   subpath. _Recommend: yes._ No consumer exists outside TeXRA's hosts;
   each generic action becomes a `RuntimeRequest` arm instead.

## Verified

- Branched from `origin/main` at `85ef1f3765`. Read the durable, codemode,
  core-concepts and GUI docs, the merged H3 commits (#13635, #13637) and the
  open PRs (H2 is #13638; none touches `src/model` or `src/auth`).
- Read the SDK entry files, the plugin table and manifest,
  `processRuntime.ts`, `installProcessRuntime`, `rowVersions.ts`, the
  `sessionEvent.ts` arms, `WriteTool.ts`, the ratchet baselines and the
  alias and copy scripts. A script classified each production file by §1
  and resolved every alias import: 37 harness files import app modules, and
  app and host files reach 254 harness-internal specifiers.
- Ruling 2: read every import and every settings or secrets read in
  `src/model` and `src/auth`. The `llm` entries: listed every importer of
  each of today's six subpaths, walked the import graph (type imports
  included) from the desktop renderer and both webview frontends to
  `@texra-ai/llm`, and read the four bundle configs and
  `validate-artifacts.mjs`. The dynamic-import findings are read from the
  configs and the two existing SDK imports, not from a build. Ruling 1: counted with `git grep -i ledger` and split the
  hits by meaning. Roster case: searched `src/test-kernel` for a suite that
  pins a plugin list or offered tools.
- pi-durable 1.0.0 ships its tools as a built-in extension, `/node`
  subpaths and `./testing`; this note follows the first two. The
  deepseek-harness points (`da00f7f535`) come from a separate study.
- Not run: any build, typecheck or test. Counts in §1 are approximate where
  a directory splits (marked ≈).
