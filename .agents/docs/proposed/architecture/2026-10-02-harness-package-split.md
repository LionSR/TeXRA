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
written in Effect throughout, with TeXRA as an app built on it, and he wants
it before 1.0 (2026-10-01, 2026-10-02). The durable doc drew the boundary as
an import graph and deferred the physical split until after the freeze. This
note moves the split before the freeze and says how to do it.

There are three packages:

| Package             | Path               | Owns                                                                                                                                                                    | Files today |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `@texra-ai/harness` | `packages/harness` | The ledger, the loop, sessions and storage, the Registry and Step, the ports, model access, trust, MCP and data plugins, the built-in plugins, the transcript row model | about 560   |
| `@texra-ai/llm`     | `packages/llm`     | The wire protocols to model providers. Unchanged                                                                                                                        | 33          |
| `@texra-ai/texra`   | `packages/texra`   | The app plugins, the documents plugin (round mode), LaTeX, the UI kit, the app's settings rows, the host-side controllers, telemetry                                    | about 300   |

The three hosts (`packages/cli`, `packages/desktop`, `packages/extension`)
and `packages/trace-viewer` stay separate packages. They are TeXRA products
and depend on both `@texra-ai/harness` and `@texra-ai/texra`.

Most of the boundary is already clear. H3 removed the table import, the
`bibPath` field, the LaTeX types and the setting read from the kernel. A
fresh scan of the tree at `85ef1f3765` still finds 37 harness files that
import app code. Most of those imports are a type or constant filed in the
wrong directory. Five are real couplings, and this note fixes each of them:
round mode, the composition root's option bag, the closed service unions,
two app row kinds, and `write_file`'s LaTeX filter.

## 1. The three packages

### Directory map

| Today                                                                     | Files                 | To `@texra-ai/harness`                                                                                                                                                                                                                              | To `@texra-ai/texra`                                                                                                                                                                      |
| ------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent`                                                               | 153                   | ≈127: `core/`, `runtime/` without `loop/rounds.ts`, `followUp/`, `trace/`, `prompt/`, `storage/`, `codeSandbox/`, `index/` (agent catalog), `templates/`, `workspaceAgents/`, `debug/`, `export/schemas.ts` (the conversation format storage reads) | ≈26: `output/` (17, the documents plugin), `runtime/loop/rounds.ts`, `export/` formatters (chat export to LaTeX and Markdown)                                                             |
| `src/tools`                                                               | 175                   | ≈93: the engine (`liveRegistry`, `liveTools`, `toolTable`, `serverHolds`, `pluginLayers`, `pluginArms`, `catalogEntries`, `core/`, `approval/`, `mcp/`, `support/`, probes) and the built-in plugins in §3                                          | ≈82: `registry.ts` and `pluginManifest.ts` (TeXRA's binding), the app plugins in §3, `approval/latexPreview.ts`                                                                           |
| `src/shared`                                                              | 171                   | ≈128: `session/`, the core arms of `schemas/`, `state/` (harness rows only, §4), `tools/`, `runs/`, `plugins/`, `model/`, `config/`, `utils/`                                                                                                       | ≈43: `settingsView/`, `commands/`, `launcher/`, `litControllers/`, `monaco/`, `highlighting/`, the LaTeX constants, `schemas/output.ts` and `schemas/inquiry.ts`, the webview host bridge |
| `src/controllers`                                                         | 73                    | ≈21: `session/` without the host-side modules                                                                                                                                                                                                       | ≈52: `mainView/`, `modelAccess/`, `onboarding/`, `progressView/`, `settingsView/`, `approval/`, and the host-side `session/` modules (§5)                                                 |
| `src/common`                                                              | 35                    | 33: errors, files, parsing, `plugins/` (trust, install record, MCP servers, hooks), secrets, storage                                                                                                                                                | 2: `teams/`                                                                                                                                                                               |
| `src/utils`                                                               | 60                    | 58                                                                                                                                                                                                                                                  | 2: the LaTeX dependency checks in `system/`                                                                                                                                               |
| `src/platform`                                                            | 20                    | 20: the ports at `.`, `defaults/` behind `./node`                                                                                                                                                                                                   |                                                                                                                                                                                           |
| `src/model`, `src/auth`                                                   | 16, 29                | All: routes, providers, subscription sign-in. This is the Models port's half that reads settings; `@texra-ai/llm` stays wire-only                                                                                                                   |                                                                                                                                                                                           |
| `src/skills`, `src/transcript`, `src/logger`, `src/eventBus`, `src/hosts` | 6, 6, 5, 1, 1         | All                                                                                                                                                                                                                                                 |                                                                                                                                                                                           |
| `src/ui`                                                                  | 59                    | 7: `transcript/`, which becomes `transcript/rows/` under `@transcript/*`                                                                                                                                                                            | 52: `wa/`, `styles/`, `markdown/`, `copy/`, `formatting/`                                                                                                                                 |
| `src/latex`, `src/replacement`, `src/telemetry`, `src/housekeeping`       | 30, 8, 3, 5           |                                                                                                                                                                                                                                                     | All                                                                                                                                                                                       |
| `packages/agent`                                                          | 7                     | Becomes `packages/harness`'s entry files                                                                                                                                                                                                            |                                                                                                                                                                                           |
| `src/test-kernel`                                                         | 515 tests and helpers | Stays one tree at the repo root; ratchets re-keyed to the new paths                                                                                                                                                                                 |                                                                                                                                                                                           |

The agent YAMLs, skills and plugin resources in
`packages/extension/resources/` are app data already, and they stay where
they are. The desktop (`electron-builder.yml:41`) and the CLI
(`scripts/copy-resources.mjs:8`) already copy them from there, and `vsce`
packs only files under the extension's own directory. Moving them would add
a third copy step and remove no import. The `agent` plugin's skills in
`resources/plugins/workflow-script/` are the one harness resource. They move
into `packages/harness/resources/`, and the three hosts copy that directory
too.

### Where the UI toolkit goes

`src/ui` splits. The transcript row model (`src/ui/transcript/`, 7 files,
2,454 lines, including `scriptStage.ts`) goes to the harness. The rest
(Web Awesome kit, styles, markdown and KaTeX, copy tables) goes to the app.

The reason is that the row model is part of the session view, not of a
renderer. `sessionFold.ts:83`, `sessionView.ts:51`, `transcriptState.ts`,
`transcriptReads.ts` and `transcriptFold.ts:30` import it. The SDK already
exports `TranscriptView`, whose rows are `TranscriptRow`. Putting the row
model in the app would make the kernel's fold import the app. The kit has no
such reader. Its only harness consumers are four misplaced imports: icon
names in `schemas/agentPresets.ts` and `schemas/todoDisplay.ts`, and account
copy in `quotaFallbackRoutes.ts` and `runtime/modelRoutes.ts:40`. Those move
to their owners in M3. The row model's own import of `@ui/copy/workflowCall`
(`projectTranscriptRow.ts`, `scriptStage.ts`) moves with it, because it is
the tally text the row model prints.

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
  }): Layer<Sessions, PlatformConflict | PluginConflict>; // plugins: new (M2)
}
interface Session {
  roots: WorkspaceRoots;
  start(input: StartInput): Effect<Run, LaunchError | RunFailure>;
  resume(runId: RunId): Effect<Run, LaunchError | RunFailure>; // new (H4, in M2)
  request(r: RuntimeRequest): Effect<Outcome, RequestError>;
  view: { changes: Stream<SessionView> };
  subscribe(i: readonly TranscriptSubscription[]): Effect<void, never, Scope>;
}
interface Run {
  runId;
  result;
  view;
  events;
  interrupt;
} // unchanged
class Plugins extends Context.Service<
  Plugins,
  {
    contribute(p: Plugin): Effect<void, PluginConflict, Scope>; // new (H4, in M2)
  }
>() {}
```

The ports are fields of `AgentPlatform` (`runtime.ts:50`). Each is served as
an Effect service:

| Port          | Platform field                   | Service                                                 |
| ------------- | -------------------------------- | ------------------------------------------------------- |
| Storage       | `roots` (storage paths)          | `GlobalDatabase`, `ProjectDatabases`; ledger internal   |
| Models        | `languageModel`, `secrets`       | `LanguageModel`, `Secrets`; routes over `@texra-ai/llm` |
| Settings      | `roots.config`, the state stores | `AppState`, `ConfigProvider`                            |
| Execution env | (none: Node defaults)            | `WorkspaceFs` + `ChildProcessSpawner`, per run after H4 |
| Sandbox       | (none)                           | `CodeSandbox`, the `codemode` plugin's session layer    |
| Agents        | `agentDirectories`               | `AgentDirectories`                                      |
| Usage         | `usageLog`                       | `UsageLog`; the app's `src/telemetry` implements it     |

`mcpConfigPath` stays a platform field. The installed-plugin reader and the
MCP loader are harness machinery, not a plugin value.

### The extend half: `Plugin`

The durable doc's sketch, made precise so that it can replace the manifest
and the five `satisfies` tables (`registry.ts:156-283`) and the manifest
flags that point into them (`plugins.ts:60-110`):

```ts
interface Plugin<ROut = never> {
  readonly id: PluginId;
  readonly revision: string; // 'builtin' for first-party
  readonly requires?: readonly PluginId[]; // first-party only (below)
  readonly tools?: readonly Tool<HarnessServices | ROut>[]; // defineTool(...)
  readonly prompt?: PromptSection;
  readonly continuation?: Continuation<ROut>;
  readonly rounds?: RoundPolicy<ROut>; // per agent category (M1)
  readonly arms?: readonly PluginArm[]; // plugin.fact kinds, versioned
  readonly settings?: readonly SettingRow[]; // §4
  readonly availability?: Availability; // probes → blocked reasons
  readonly processLayer?: Layer<ROut, never, HarnessServices>;
  readonly sessionLayer?: Layer<ROut, never, HarnessServices | SessionServices>;
  readonly agents?: string; // directories, as data
  readonly skills?: string;
}
declare const definePlugin: <ROut>(plugin: Plugin<ROut>) => Plugin.Any;
```

- **Typed requirements.** `definePlugin` checks at compile time that every
  tool, continuation and round policy needs only harness services and what
  the plugin's own layers add. The Registry stores the erased value, and the
  step provides the pinned layers. This replaces the closed
  `PluginServices` union (`processRuntime.ts:97`) and the app tags in
  `ProcessServices` (`:68`): `InquiryRecords`, `UpdateCheckRecords`,
  `SetupPlatform`, `LeanLanguageServices`. A kernel cannot list an app's
  services.
- **Options, not hooks.** Where the app changes a built-in, the built-in
  takes options. H3 already did this for `agent`: `agentTool(options)`
  (#13637) carries TeXRA's figure fields. `fileOps({ writeFilter })` does the
  same for the `.tex` replacement in `write_file` (`WriteTool.ts:48-55`).
  This needs no new Registry kind and no wrapper.
- **Contribute in a `Scope`.** `Plugins.contribute` is `Registry.contribute`
  for each of the plugin's maps under one scope, as the durable doc says.
- **Dependencies.** An agent's dependencies are derived from its tool list:
  the plugin that offers each declared tool in the pinned generation. A hard
  `requires` is for first-party values only. It is resolved at `Step.open`,
  it is transitive, and a cycle is refused when the plugin set is built
  (`PluginConflict` with reason `cycle`, at `Sessions.layer` or `contribute`).
  Nothing turns a required plugin on automatically. There are no version
  ranges, no package manager and no lockfile. A dependency that is not
  satisfied yields one typed blocked reason, `{ kind: 'pluginOff' |
'pluginUntrusted' | 'missingBinary' | 'missingCredential', plugin }`, beside
  the GUI doc's `agentMissing`. It is held in the projection (durable D5),
  not in a row.
- **Trust.** A first-party value is trusted by construction
  (`revision: 'builtin'`), because the embedder owns the process. Third-party
  plugins stay data, MCP and hooks (ruling Q1), with trust per content digest
  (`pluginTrust.ts`). A trust decision is a `request.opened` row answered
  through `Session.request`. There is no public Trust service.

### Subpath exports

| Subpath        | Contents                                                                                                    | Runs in      |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------ |
| `.`            | `Sessions`, `Session`, `Run`, `Plugins`, `Plugin`, `definePlugin`, `defineTool`, the errors, the port types | any          |
| `./plugins`    | The built-in plugin values of §3, `fileOps(options)` and `agent(options)` included                          | any          |
| `./schemas`    | Agent config and run-end schemas (exists), `SessionEvent`, `PluginArm`, `SettingRow`                        | browser-safe |
| `./transcript` | The row model and its projections, for renderers                                                            | browser-safe |
| `./node`       | `nodePlatform`, the SQLite store, the Node spawner, the code-sandbox worker asset                           | Node         |

`./schemas` and `./transcript` exist because the webview frontends need
schemas and rows and cannot load `.`. A `./testing` subpath waits for a
named external consumer, as the durable doc says.

**No Promise API.** None of the consumers needs one. The three hosts and
the trace viewer are already Effect at their entry points, and the
superseding ruling of 2026-09-21 is quoted in `packages/agent/src/index.ts`.

### Today's deep imports: public or internal

| Specifier (today)                                                                                                                                                                                                                  | Becomes                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `@agent/core/definition/AgentConfig`, `AgentDataclass`, `@agent/runtime/RunEndResult`                                                                                                                                              | public, `./schemas` (already)                                   |
| `@agent/core/tools/ToolTypes` (`ITool`, `ToolGuard`), `@tools/core/definition` (`defineTool`), `@agent/trace` (`AgentEvent`)                                                                                                       | public, `.`                                                     |
| `@shared/session/{runtimeRequest,requestErrors,database}` (request, outcome and open errors), `@shared/session/sessionView` (types)                                                                                                | public, `.`                                                     |
| `@platform/{interfaces,secrets,languageModel,workspaceRoots}` port types; `@platform/defaults/*`                                                                                                                                   | public, `.` and `./node`                                        |
| `@tools/toolTable` (`Continuation`, `PromptSection`), `@tools/pluginArms` (`PluginArm`)                                                                                                                                            | public, through `Plugin`                                        |
| `@agent/runtime` barrel (`closeAllSessions`, `installedProcessRuntime`), `@agent/runtime/loop/*`, `ModelInvoker`, `RunLedger`, `SessionEvents`, the folds, `storeSchema`, `rowCodec`, `liveRegistry`, `liveTools`, `codeSandbox/*` | internal                                                        |
| `@agent/index`, `@agent/storage`, `@agent/followUp`, `@agent/export` (the hosts' five, `host-agent-import-baseline.json`)                                                                                                          | internal; hosts reach them through `Session` and `request` (M7) |

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

The durable doc listed the last four of these as optional harness plugins.
This note puts them in the app, so that the harness ships what the durable
contract needs plus general file, shell, web and memory tools, and nothing
that needs a vendor SDK or a background service. With them, eight of the
SDK's dependencies leave `packages/harness/package.json`:
`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `arxiv-client`,
`@jamesgopsill/crossref-client`, `bibtex`, `identifiers-arxiv`,
`content-disposition` and `tar`.

## 4. Proving TeXRA is just an example

**The ratchet.** App and host files import the harness only through its
package name and subpaths (`@texra-ai/harness`, `/plugins`, `/schemas`,
`/transcript`, `/node`). The harness imports nothing from the app. The
second rule is an ESLint zone with no baseline, added in the move PR (M6),
which is the PR that clears the last edge, as the durable doc requires. The
first rule is the existing set-based deep-import ratchet, widened in what it
measures: it counts every harness-internal alias an app or host file
reaches, not only `@agent/*`. Today that is 254 distinct specifiers (173
from the hosts, 170 from the app code, overlapping). The new file starts
with those 254, and `host-agent-import-baseline.json` (18 entries, a subset)
is deleted. It only shrinks (Q2).

**The manifest moves to the app.** `registry.ts` and `pluginManifest.ts`
become `packages/texra/src/plugins.ts`: a list of `definePlugin` values. The
harness's `./plugins` exports its built-ins, and nothing in the harness
names an app plugin. Each host passes `[...harnessPlugins, ...texraPlugins]`
to `Sessions.layer`. The SDK's `nodePlatform` passes only the built-ins.
Today it binds TeXRA's table (`runtime.ts:38`, `:190`).

**Settings layer by owner.** A setting row (today's `StateSettingEntry`) is
declared by its owner. The harness's rows (model, approvals, retries,
compaction, concurrency, skills, logging) live in the harness. Each plugin's
rows ride on its `Plugin` value; the manifest's `settings` field already
lists them per plugin. The catalog is the concatenation of the two, built
once at `Sessions.layer`. The settings view and `texra config` read that
catalog. `stateSettings.ts` (1,345 lines) loses its two app imports
(`latexConfig`, `replacementCategories`). The closed `GlobalStateKey` and
`WorkspaceStateKey` enums (`stateKeys.ts`) split by owner. Key strings stay
`texra.*`: this is no new format and needs no migration, because a key is
data that the app's config file holds.

**The hardest shared thing is the closed row union.** The settings catalog
is easy, because its rows are already data per plugin. The stored row
schema is not. Two app kinds sit in the harness's `SessionEvent` union and
in its folds:

- `output.produced` (`sessionEvent.ts:323`), the documents plugin's round
  outputs. It is written once (`documentRounds.ts:490`), but its schema
  (`schemas/output.ts`, 347 lines) and the run's files reach about a dozen
  harness files: `sessionFold`, `sessionView`, `runRows`, `runRecords`,
  `progressEvents`, `agentConfig`, `fileFields`, the round-keyed sidecars in
  `runState.ts`, and the row model's `toolRowSections`.
- `inquiryThreadUpdated` (`:352`). It has its own aggregate kind,
  `inquiry` (`sessionEvent.ts:111`), and a special parent edge in
  `referencedAggregates` (`:497`).

Split them with the mechanism that already exists, `plugin.fact`.
`output.produced` becomes the `documents/output` arm at version 1. The
listing already folds the latest value per (plugin, kind), and the run's
file list becomes the documents plugin's read of that value. The sidecars
go with it. `inquiryThreadUpdated` becomes the `external-inquiry/thread`
arm. The aggregate kind `inquiry` becomes `plugin`, an aggregate that a
plugin owns and keys, and `plugin.fact` gains a nullable `parent` run edge
that `referencedAggregates` reads in place of the inquiry special case. The
harness then folds no app kind, and one arm, `plugin.fact`, carries all
app state. Both are row changes, so they land before the freeze (Q3).

## 5. Hosts

The CLI, the desktop app and the extension are TeXRA products. The
recommendation is that nothing in them moves into the harness.

- **Host runtime layer.** There are two doors today: hosts call
  `installProcessRuntime` (`sessionLayer.ts:1071`), and the SDK calls it
  through `acquireProcess`. That entry point is the harness's composition
  root. It stays in the harness, but it loses its app options (`setup`,
  `inlineComments`, `lean`, `toolAvailability`; `:1013-1028`) and the two
  app record layers (`:1099-1100`). Those become the owning plugins'
  `processLayer`s, or `hostLayer`s where a host supplies them (the
  extension's Lean and inline-comment providers). After that, a host
  differs from the SDK only in its platform and its plugin list.
- **Host-side session controllers go to the app.** `hostRunActions` (708
  lines), `hostDraftRequests`, `hostSnapshotSource`, `sharedHostRequests`,
  `SessionBridge`, `attachSessionHost`, `webviewSessionLayer`,
  `hostCallFailure`, `workspaceFileOptions` and the two record modules serve
  TeXRA's three hosts. `sharedHostRequests` imports `mainView` and
  `progressView` controllers, and `hostSnapshotSource` imports `teams`. A
  `./host` subpath would publish about 2,500 lines of surface to no external
  consumer. Their deep imports join the ratchet's baseline. Each generic
  action they perform (resume, stop, retry with a key, follow-up, and fork
  after H5) shrinks it by becoming a `RuntimeRequest` arm that the hosts
  send through `Session.request` (Q6).
- **TUI kit.** It stays in `packages/cli`. Nothing outside the CLI renders
  through Ink.

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

**Order.** The row split (M4) comes before the freeze. The physical move
(M6) is a rename and changes no stored shape. It does not have to hold the
freeze, but the owner's "split before the freeze" reads naturally as both,
and Q5 asks which one is meant.

## 7. Migration plan

Each step is one PR (owner: bigger PRs). Steps M1 to M5 move no files, so
they rebase cleanly against the running lanes. M6 is the move. No step
leaves a shim, a re-export or a forwarding module. A moved symbol's
importers are rewritten in the same PR.

| Step | Work                                                                                                                                                                                                                                                                                                                                                                                                                        | Size                       | Depends on             | Freeze |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------- | ------ |
| M1   | Round mode becomes the documents plugin's `rounds` contribution, keyed by category and read once at run open (`toolUse.ts:143-144` loses the category branch; `rounds.ts:127-142` loses `makeDocumentRounds`). This is H3's remaining violation, 4                                                                                                                                                                          | M, ~15 files               | none                   | no     |
| M2   | `Plugin`, `definePlugin`, `Sessions.layer({ platform, plugins })`, `Plugins.contribute`, `Session.resume`, and the spawner moved onto the run layer (H4, absorbed). The manifest and its five tables become plugin values. The composition root loses its app options and record layers, and `ProcessServices`/`PluginServices` lose their app tags. The SDK stops binding TeXRA's table                                    | L, ~60 files, net deletion | M1                     | no     |
| M3   | The remaining harness→app imports. Misplaced types and constants move to their owners: `ToolCategory` and the other types out of `settingsViewMessages` (6 importers), `workflowOutput`, icon names, account copy, `teams`, `latexToolchain`. `fileOps({ writeFilter })`; `accept_run_files` moves to `documents`; `SessionRequests` stops importing `inquiryActions`. The host-side session modules are marked for the app | M, ~40 files               | M2                     | no     |
| M4   | Rows: the `documents/output` and `external-inquiry/thread` arms replace `output.produced` and `inquiryThreadUpdated`; the `plugin` aggregate kind and `plugin.fact.parent`; the plugin id changes. The golden store is regenerated once, with H1's if they land together                                                                                                                                                    | M, ~30 files               | H2 (#13638) merged; M2 | before |
| M5   | The settings catalog by owner: harness rows, plugin rows on `Plugin`, the enums split                                                                                                                                                                                                                                                                                                                                       | M, ~25 files               | M2; after G6           | no     |
| M6   | The move, rename only: `git mv` of about 560 files into `packages/harness/src` and about 300 into `packages/texra/src`; `packages/agent` becomes `packages/harness` (`@texra-ai/harness`); `tsconfig.json` paths retargeted; dependencies split; ESLint zones and ratchet paths re-keyed with identical entries; the harness-imports-no-app zone at zero; the widened deep-import ratchet                                   | L in files, S in review    | M1–M5, H1; G2 merged   | see Q5 |
| M7   | Shrink the deep-import baseline, one host per PR, through `Session.request` arms and public exports                                                                                                                                                                                                                                                                                                                         | M each                     | M6                     | no     |

**Path aliases.** The alias names stay. `tsconfig.json` maps `@agent/*`,
`@shared/*`, `@tools/*`, `@controllers/*`, `@common/*`, `@utils/*`,
`@platform/*`, `@model/*`, `@auth/*`, `@skills/*`, `@transcript/*`,
`@logger/*`, `@eventBus/*` and `@hosts/*` into `packages/harness/src`.
`scripts/aliases.mjs` derives the Vite and esbuild aliases from that file,
so the builds follow. App files take one new alias, `@texra/*` →
`packages/texra/src/*`. `@latex/*`, `@replacement/*`, `@telemetry/*`,
`@housekeeping/*` and `@ui/*` point into it. A mixed directory cannot keep
one alias across two packages, so the app files that leave `@tools/*`,
`@shared/*`, `@controllers/*`, `@agent/*` and `@common/*` get their
specifiers rewritten by a codemod in M6. The codemod rewrites the
ratchet's baseline in the same commit, since a rewritten specifier is a new
string with the same target. Inside the harness, the old names stay
internal.

**Ratchets only shrink.** `architecture-edges-baseline.json` loses every
harness→app pair in M1 to M3 (`agent → latex`, `controllers → tools` for the
app plugins, `shared → ui` and the others) and is re-keyed by package in
M6 with no new pair. `file-size-baseline`, `knip-baseline` and the
effect-migration allowlists are re-keyed by path in M6 with the same counts.
`host-agent-import-baseline.json` is deleted in favour of the wider ratchet,
whose starting set contains the old one. The `Effect.run*` door
(`packages/{extension,desktop,cli,agent}/src`) renames `agent` to
`harness`. `packages/texra` gets no door: it is a library.

**Order against the running lanes.** H2 (#13638, open) merges first: it is
on the freeze's path, and M4 builds on its shapes. H1 follows. M1 to M3 can
start now, in parallel with H1, G2, G3 and G6. They touch the plugin table
and the composition root, which those lanes do not touch, except G6's
plugin list, which M2 rebases onto. M5 waits for G6, which rewrites the
Settings › Plugins rows. M6 waits for M1 to M5, H1 and G2, which reworks
`src/ui/transcript/` and the hosts' script card. It lands before H5, G4 and
G5 start, so that those lanes are written against the new tree and never
rebase across a move. H6's crash suite comes after M6. It takes the plugin
set as a `Layer` and runs twice, once with the built-ins only and once with
TeXRA's plugins. That second run is the end-to-end proof that TeXRA is one
plugin list among others.

**Build and packaging.**

- _Extension (VSIX)._ The esbuild entry is unchanged, and the aliases come
  from `tsconfig.json`. `verify-vsix-contents.mjs` keys on
  `extension/resources/`, which does not move. The harness resources copy
  joins the existing resource step.
- _Desktop._ `esbuild.main.mjs` and the Vite renderer read the same aliases.
  `electron-builder.yml:41` gains the harness resources `from:` entry.
- _CLI._ The bundle follows the aliases. `copy-resources.mjs` copies the
  harness resources too.
- _SDK._ `packages/agent/scripts/` moves with the package. The declaration
  rewrite and `validate-artifacts.mjs` (the provider-type leak check) cover
  the new subpaths. `example:packed` is renamed.
- _Code-sandbox worker._ `scripts/code-sandbox-worker.mjs` reads the new
  path, and the worker asset ships under `./node`.
- _Tests._ `src/test-kernel` stays where it is and imports through the same
  aliases, so the move changes no test. `dependencyDirection.vitest.ts` and
  `VSCODE_FREE_ZONE_DIRS` are re-keyed together.

## 8. Owner questions

1. **Names and paths.** `@texra-ai/harness` at `packages/harness`, renamed
   from `@texra-ai/agent`; `@texra-ai/llm` unchanged; the app at
   `packages/texra` as `@texra-ai/texra` (the durable doc proposed
   `theorist`). _Recommend: yes._ "texra" matches the owner's own phrasing,
   and the theorist is the first bundle inside it, not the whole app.
2. **The deep-import ratchet starts at 254 and shrinks.** The alternative
   is to make public, in M6, every internal module an app or host file
   reaches today. _Recommend: the baseline._ Publishing 254 modules to make
   a count zero would freeze the internals as API. M7 shrinks the count
   through `Session.request` arms instead.
3. **App rows become plugin arms before the freeze.** `output.produced` →
   `documents/output`, `inquiryThreadUpdated` → `external-inquiry/thread`,
   the `inquiry` aggregate kind → `plugin`, and `plugin.fact` gains a
   nullable `parent`. _Recommend: yes._ It removes two kinds and adds
   none, and the harness then folds no app state.
4. **Four plugins go to the app**, not the harness: `codex`,
   `claude-agent`, `github-pr-subscription`, `external-inquiry`. The durable
   doc had them as optional harness plugins. _Recommend: app._ They bring
   vendor SDKs or background services. Any of them moves to the harness
   when a second app needs it.
5. **Which split gates the freeze.** Is it the row split (M4) only, or the
   physical move (M6) as well? _Recommend: M4 gates the freeze, and M6
   lands right after, before H5._ The move changes no stored byte, and
   holding the freeze for an `L` rename buys nothing.
6. **The host-side session controllers go to the app**, with no `./host`
   subpath. _Recommend: yes._ There is no consumer outside TeXRA's three
   hosts. Each generic action becomes a `RuntimeRequest` arm instead.

## Verified

- Ran `git fetch` and branched from `origin/main` at `85ef1f3765`. Read the
  durable doc ("The shape", "The harness boundary", the lanes, the rulings),
  the codemode doc ("Separation of concerns", "Ports"), the core-concepts
  primitives and the 2026-09-27 and 2026-09-30 decisions, and the GUI doc's
  lanes and blocked-reason projection.
- Read the merged H3 commits (#13635 `6ccab286f6`, #13637 `11ef6e2168`;
  the `refactor/harness-boundary-latex` branch is squash-merged as #13637)
  and the open PR list (H2 is #13638).
- Read `packages/agent/src/{index,node,schemas}.ts`,
  `effect/{sessions,runtime}.ts` and `package.json`; `packages/llm/package.json`;
  `src/tools/{registry,toolTable,plugins,pluginManifest,pluginArms}.ts`;
  `src/platform/processRuntime.ts`; `installProcessRuntime` in
  `sessionLayer.ts`; `rowVersions.ts`; the `plugin.fact`, `output.produced`
  and `inquiryThreadUpdated` arms and the aggregate kinds in
  `sessionEvent.ts`; `WriteTool.ts`; the ratchet baselines; `tsconfig.json`
  paths and `scripts/aliases.mjs`; the resource copy sites.
- Counted files with `git ls-files`. I measured the cross-boundary imports
  with a script that classifies each production file by the map in §1 and
  resolves every alias import: 37 harness files import app modules, and app
  and host files reach 254 distinct harness-internal specifiers. I mapped
  each SDK dependency to the directories that import it.
- Compared pi-durable 1.0.0's package (`README.md` "Concepts" and
  "Extensions", `package.json` exports). Its kernel ships its coding tools
  as a built-in extension under `./tools`, its Node pieces under `/node`
  subpaths, and a `./testing` export. This note follows the first two and
  defers the third.
- Not run: any build, typecheck or test suite. The file counts in §1 are
  approximate where a directory splits (marked ≈).
