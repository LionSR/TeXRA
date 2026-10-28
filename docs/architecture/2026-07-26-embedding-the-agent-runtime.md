# Embedding the TeXRA Agent Runtime

**Status: internal. Not published on texra.ai.** A program outside this
repository embeds the harness through the published package
`@texra-ai/harness` and its entries (`.`, `/node`, `/plugins`, `/schemas`,
`/transcript`), documented in `packages/harness/README.md`:
`Sessions.layer({ platform, plugins })` composes everything §1 walks through,
and the §1 example uses only those entries. The rest of this note documents
the internal composition behind that layer, reached through the repo-root path
aliases declared in `tsconfig.json`, for work on the harness itself. Plain
`tsc` output does not rewrite those aliases, so none of the internal names
below is reachable from an installed package, and none is a stable contract.

Every claim below is cited to `file:line`. The original baseline was verified
at the PR base (`5fc03f9436`); review corrections were rechecked against
`origin/main` (`97543989b5`). None of the 50 cited files changed between those
snapshots. §1, §2, §3 and §5 were rewritten against `main` at `bac10c1` for
#12950, after the request model and the host bootstrap moved. Where the code is
awkward, this note says so rather than describing an intended future shape.

---

## 1. The minimum sequence to a working root launch

The sections below separate minimum launch requirements from shipped-feature
parity. A raw agent loop needs an installed process runtime, usable credentials,
agent directories, a session, and a populated registry. When a run can open
requests, something must also decide them (§3); presentation goes through the
session's interactions attachment, and there is no separate presentation-host
argument. The Lean tools the shipped hosts compose (the `lean4` plugin in
their plugin list) are a shipped-feature choice; the raw loop needs no Lean
plugin at all.

### Step 1 — `processLayer({ storageRoot, plugins, secrets, agentDirectories, … })`

There is no `createNodePlatform` factory and no process-wide platform object
any more: the `Platform` module was deleted (#13060). Every process fact has
one of two owners, and an embedder supplies each one there:

- **Process services** (the `agentDirectories` port,
  the optional `toolMissingReporter`, the filesystem, `Path`, secrets,
  application state, the resume port) are
  Effect services provided once per process by `processLayer`
  (`packages/harness/src/effect/processLayer.ts`, options in
  `packages/harness/src/controllers/session/sessionLayer.ts`), which also
  serves the `Sessions` that open the process's sessions. A host builds a
  `ManagedRuntime` over it and disposes that runtime on shutdown.
- **Per-workspace services** (the workspace root, its storage paths, its
  configuration and its state stores) are a `WorkspaceRoots`
  (`@platform/workspaceRoots`) carried by each `SessionHandle`, so one process
  can hold sessions rooted in several folders. Build one with
  `createNodeWorkspaceRoots` (`packages/harness/src/platform/defaults/nodeHost.ts:52-69`), which
  picks the config provider.

`agentDirectories` is the port that names the three directories the registry
scans. `new AgentDirectoryService({...})`
(`packages/harness/src/agent/index/AgentDirectoryService.ts:62-68`) builds one over a
packaged resources tree; its `builtIn()` reads that tree
in place. Nothing is copied into global storage, so there is no bundle-copy
step to run and no version state key to keep.

The runtime skill sources are a `processLayer` option (`skills`: the
bundled resources tree, and the CLI's source flags), which the layer serves
as `HostSkillSources` beneath every session; the model HTTP dispatcher is
installed by `processLayer` itself. Beside that layer, a Node root calls
`bootstrapHost` (`packages/texra/src/controllers/hostBootstrap.ts:46-54`)
once, on its own process runtime: it seeds the first-install disabled
tools. An embedder that skips either gets a runtime without them, not a
broken one.

Only a composition root imports `processLayer`; ESLint pins the import
to the files in `COMPOSITION_ROOT_FILES` (`eslint.config.mjs`).

### Feature-parity step — the `lean4` plugin's process layer

TeXRA's Lean tools are the `lean4` plugin
(`packages/texra/src/tools/integrationPlugins.ts`), and its process layer is
the Lean language-server pool. By default that is the direct
`lake env lean --server` pool (`directLeanLanguageServices`,
`packages/texra/src/tools/lean/direct/directLspAdapter.ts`); a host passes its
own services in its place through `texraPlugins({ lean })`, as the VS Code
extension does with its Lean 4 extension bridge:

```ts
processLayer({ /* … */, plugins: texraPlugins({ lean: myLeanServices }) });
```

The two conditional tool injections — `memory` and the unified `plan` tool
that drives the goal loop — are not part of this step: they are data on the
memory-workflow plugin (`injectedWhen` in `packages/harness/src/tools/plugins.ts`), and their
settings are read when a run resolves its tools against the `ToolRegistry`
table the process runtime provides.

The pool the layer builds spawns nothing until a Lean tool is first used, and
its servers stop when the process runtime is disposed.

A composition without the `lean4` plugin offers no Lean tools; the `memory`
and `plan` injections are present either way.

### Step 2 — credential resolution

There is no model-access bootstrap call. A run binds its model through `ModelAccess`
(`packages/harness/src/agent/runtime/modelAccess/`), which resolves the route's one credential
in `credentials.ts` (an API key, or the ChatGPT or Grok subscription session).

Credential resolution uses the caller's own provider API keys or subscription
credentials only; there is no server-side model access to configure. A
stateless BYOK embedder needs no auth setup at all — a host that wants
persisted state (settings, credentials) must complete Step 1 before the first
model call.

### Step 3 — agent directories

To use the packaged agent definitions, install a port that names the tree they
sit in. There is no copy step: `builtIn()` resolves
inside `resourcesPath`, and the files are read where they are.

```ts
const agentDirectories = new AgentDirectoryService({
  channel: 'my-embedder',
  resourcesPath, // dir containing agents/, skills/
  state: { get: () => Effect.succeed(undefined) },
});
// Served as `AgentDirectories` by the Step 1 layer:
// processLayer({ …, agentDirectories: AgentDirectories.layer(agentDirectories) });
```

`state.get()` reads the stored setting that names the user-configured
custom agent directory; `undefined` means none. The three methods return Effects, not Promises
(`packages/harness/src/agent/index/AgentDirectoryService.ts:70-86`); a failure to resolve a
directory is an `AgentDirectoriesFailed`, and the `issueReporter` option
decides how it surfaces (the default logs it at `warn`).

Alternatively, skip the packaged tree entirely and hand `processLayer` an
`AgentDirectoriesPort` of your own that points at your directory. See
[§2](#2-agentdirectoriesport-is-two-directory-paths-not-agent-values).

### Prerequisite A — a session

A root launch runs on a session (`session.runs.launch`). The CLI bootstrap in
`packages/cli/src/runtime/initPlatform.ts` prepares one memoized session-opening
Effect; commands run `services.session` when they need a session. Utility commands
that need no session leave the store unopened.

- `Sessions.open(roots, options)` (`packages/harness/src/effect/processLayer.ts`)
  opens the session of `roots`, returning the one already open when that
  storage root is. `options.persistent` keeps its history in the root's SQLite
  store; absent, the store is in memory and ends with the session.
- `Sessions.close(roots)` settles and releases one session, and
  `Sessions.closeAll` closes every open one at shutdown; the layer's release
  closes whatever is still open.

### Prerequisite B — the `AgentCatalog` service

Launch resolution reads the process's `AgentCatalog` service
(`packages/harness/src/agent/index/agentCatalog.ts`, public from
`@texra-ai/harness`). Its layer starts empty and the agent-catalog follower
loads it; `forLaunch` finds an agent by name, and a miss reloads the catalog
once before it fails with what the load said. `refresh` rescans every source.

### Per-session — attach host interactions when presentation is required

A root launch and `executeAgent` obtain presentation and approval behavior from
the selected session's stable `SessionHostInteractions` object. A host attaches
its adapter with `session.interactions.use(...)` and detaches that adapter
when the host presentation lifetime ends. `use` returns an `Effect` that
yields the detach disposer, so it is `yield*`ed. The attachment answers
nothing: every request a run makes of a person (retry, question, approval) is
a `request.opened` row the run's fold lists, closed by the
`request.decided` row a surface's decision commits
(`packages/harness/src/agent/runtime/HostInteractions.ts:67-74`). An unanswered request stays
parked on its row. The adapter in the example below only receives
presentation events, and sets `approvalPromptsUnavailable: true` on the
object it passes to `use` (§3), which keeps the approval-gated tools away from the model.

### Putting it together

An embedder does not run the steps above itself. `Sessions.layer({ platform,
plugins })` installs the process runtime (Step 1) over the platform's process
services, seeds the first-install tool switches, and serves the `Sessions`
that open a session over the platform's roots (Prerequisite A). The catalog
loads on its first miss (Prerequisite B). `nodePlatform` reads provider keys
from the environment (Step 2) and names the agent directory the registry
scans (Step 3). The example imports only the published entries; every name in
it is in the package's declarations (`config/api-reports/harness.api.md`,
`harness.node.api.md`, `harness.plugins.api.md`).

```ts
import { Effect, Fiber, Stream } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/plugins';

// The process services and the workspace roots: the agent directory, the
// storage directory (required; nothing falls back to a per-user default) and
// the folder the runs work in. Process-wide: build it once.
const platform = nodePlatform({
  agentsDir: './agents',
  storageDir: './.agent-storage',
  workspaceDir: process.cwd(),
});

const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots);
  // §3: with no approval handler attached, no run of the session is offered
  // a tool that requires approval, and the session denies any retry a
  // provider failure opens.
  const run = yield* session.start({
    agent: 'assistant',
    instruction: 'Hello',
  });
  const events = yield* Effect.forkScoped(
    Stream.runForEach(run.events, (event) =>
      Effect.sync(() => {
        if (event.type === 'stream.chunk') process.stdout.write(event.text);
      }),
    ),
  );
  const result = yield* run.result;
  // The run's trace ends with it, so the join drains what the result may
  // have outrun; returning on the result alone would close the scoped
  // consumer and drop the trailing events.
  yield* Fiber.join(events);
  return result;
}).pipe(
  Effect.scoped,
  // The process and its sessions live for this layer's scope; releasing it
  // closes every session, then the process under them.
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);

const result = await Effect.runPromise(program);
console.log(result.outcome);
```

`session.start` validates its input itself: a refusal before any model work
fails it with a tagged error (`AgentNotFound`, `ToolsRefused`); an input its
schemas reject fails it with `RunFailure` before admission too (`admitInput`,
`packages/harness/src/effect/sessionPrograms.ts:94-137`, wraps
`InlinePersonaSchema.parse` and `AgentConfigSchema.parse`, so a typed
`temperature: 2` is one); and a failure after admission fails `run.result`
with `RunFailure`. A host inside this repository that already holds a
`ValidatedRunRequest` launches through `session.runs.launch` on its
`SessionHandle` instead, which needs the composition root's `SessionOwner`.
`validateRunRequest` (`packages/texra/src/controllers/session/runRequests.ts`)
is the result-style helper that builds one: it returns either a
`ValidatedRunRequest` or a validation message. A caller that prefers
exceptions may instead run `AgentConfigSchema.parse` and construct the
`ValidatedRunRequest` structurally, as production extension callers do
(`packages/extension/src/commands/agent/executeCommand.ts:37-46`).
`agent`, `model`, and `instruction` all have `.prefault()` defaults
(`packages/harness/src/shared/schemas/agentConfig.ts`). A launch names no agent
category: every agent runs as a chat, and launch resolution
(`AgentCatalog.forLaunch` in `packages/harness/src/agent/index/agentCatalog.ts`) finds the
agent by name across sources. Running an agent's document task instead
means opening the run on the document recipe
(`documentTaskConfig` in `packages/texra/src/agent/output/documentRecipe.ts`).

---

## 2. `AgentDirectoriesPort` is two directory paths, not agent values

`AgentDirectoriesPort` resolves the directory paths the catalog scans:

```ts
// packages/harness/src/platform/interfaces.ts:230-238
export interface AgentDirectoriesPort {
  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  builtIn(): Effect.Effect<string, AgentDirectoriesFailed>;
}
```

Two methods, each yielding a **directory path string**. Injecting the port
redirects the catalog scan to a different real directory on disk; to pass an
in-memory agent definition directly without a YAML file on disk, pass an
inline persona object (`InlinePersonaSchema`) to `session.start({ agent: { ... } })`
instead.

### Why `scanDirectory` requires a real filesystem directory

The catalog's load resolves the agent roots and hands each to
`scanDirectory` (`packages/harness/src/agent/index/agentCatalog.ts`). Inside
`scanDirectory`:

- **Enumeration** uses the npm `glob` package with **no `fs` option**
  (`packages/harness/src/agent/index/agentYamlScanner.ts:75-80`, import at `:5`). `glob` without
  an injected `fs` reads the real Node filesystem directly.
- **Reading** three lines later goes through Effect's own `FileSystem`, which
  a test or an embedder can back with something other than the real disk.

Serving an in-memory `FileSystem` changes only the _read_ half; `glob` still
enumerates the real disk and finds nothing, so `scanDirectory` yields zero
agents unless the files exist on disk.

### What `AgentDirectoriesPort` configures

- **Skipping the packaged bundle.** `scanDirectory` returns no entries for an
  empty path (`packages/harness/src/agent/index/agentYamlScanner.ts:71`), so
  `builtIn: () => Effect.succeed('')` skips the packaged resources tree and
  points `custom()` at your own YAML directory.
- **Choosing where custom agents live.** The CLI builds its port with
  `new AgentDirectoryService({ channel: 'cli', resourcesPath, state })`
  (`packages/cli/src/runtime/cliProcessRuntime.ts:235-239`,
  `packages/harness/src/agent/index/AgentDirectoryService.ts`). An embedder can
  supply a literal implementation instead:

  ```ts
  const agentDirectories: AgentDirectoriesPort = {
    custom: () => Effect.succeed('/abs/path/to/my/agents'),
    builtIn: () => Effect.succeed(''),
  };
  ```

---

## 3. Requests and headless sessions

**Every request a run opens waits until something writes its decision.** A
headless embedder must either withhold the requests its runs can raise or
answer them through an attached approval handler (`session.attach({ approve })`)
or `session.request({ kind: 'request.decide', ... })`.

### The mechanism

A run that needs a person commits a `request.opened` row carrying what a
surface shows (a diff, a command, a question) and waits. The row is answered
by a `request.decided` row (`packages/harness/src/shared/schemas/sessionEvent.ts:379-394`).
An opened request with no decision is listed in the session view's `requests`
(`packages/harness/src/shared/session/sessionView.ts:256`;
`projectRequests` in `packages/harness/src/shared/session/sessionViewUpdate.ts`), which a host reads through
`SessionHandle.view` or the level stream `SessionHandle.viewChanges`
(`packages/harness/src/agent/runtime/SessionHandle.ts:208-217`).

Any surface decides by sending one command through the session's request
handler:

```ts
yield *
  session.requests.request({
    kind: 'request.decide',
    runId,
    requestId,
    decision: { action: 'deny', reason: 'Nobody to ask.' },
  });
```

(`packages/harness/src/shared/session/runtimeRequest.ts:42-52`). The decision lands as the
run's `request.decided` row, and the run continues from it.

`HostInteractions` is not part of this path. It is a presentation port —
events, diagnostics, PDFs, the tool-edit preview a durable payload cannot
carry — and no method on it returns a decision
(`packages/harness/src/agent/runtime/HostInteractions.ts:67-74`). Attaching a host with
`session.interactions.use(...)` is how a host sees what a run does; it never
resumes a waiting run.

### The request kinds

The payload union is the vocabulary: `toolEdit`, `bash`, `retry`,
`proposal`, `planApproval`, `externalInquiry`, `userQuestion`
(`packages/harness/src/shared/schemas/progressView/data.ts:106-128`). Every kind but
`externalInquiry` blocks the tool or turn that opened it
(`requestParksItsCaller`, `:144-148`); an external inquiry is answered later
and blocks nothing.

### Removing the requests: `approvalPromptsUnavailable`

An internal host supplies `approvalPromptsUnavailable` on the object it
passes to `session.interactions.use({...})`; on the public `@texra-ai/harness`
surface, a session with no `approve` handler attached in `session.attach({ approve })`
withholds approval-gated tools automatically. `approvalPromptsUnavailable` is a
field of `HostInteractions` (`packages/harness/src/agent/runtime/HostInteractions.ts:49`), not
an option of the root launch, and `RootLaunchOptions` has no such property. The
session's `interactions.approvalPromptsUnavailable` getter reads the attached
host's answer (`HostInteractions.ts:218-222`). Each step
applies the session's approval policy to it (`liveToolGates`,
`packages/harness/src/agent/runtime/requestPolicy.ts:186-209`) when it resolves the tools it offers
(`packages/harness/src/agent/runtime/loop/step.ts:204-207`), so a policy change or a host
attached mid-run reaches the next step's offer, and a delegated child, which
runs on its parent's session, and a run the session wakes on its own get the
same answer. When the answer is to withhold, `resolveStepTools` drops every
catalog `requiresApproval` tool before the model sees it
(`packages/harness/src/agent/runtime/agentToolResolution.ts:194-198`), so a run cannot open the
requests those tools would raise. Tools an embedder supplies in
`RootLaunchOptions.tools` are not withheld: they are overlaid after the gates
(`packages/harness/src/agent/runtime/agentToolResolution.ts:287-297`) and the model is
offered them, so a run-scoped tool that needs approval is left to the
approval guard, which may deny the call, rather than removed. The tools that open
`toolEdit`, `bash`, `proposal`, `planApproval`, `externalInquiry` and
`userQuestion` requests all declare `requiresApproval: true`.

The headless CLI host answers it from its mode alone
(`packages/cli/src/runtime/approvalAdapter.ts`); the session applies its
approval policy to that fact, so `yolo` still offers the gated tools to a run
that cannot prompt.

### Answering the rest: `retry`

`retry` has no tool behind it. The model invoker opens one on a
user-retryable provider failure, so the flag cannot remove it. The session
decides it in the batch that opens it (`decideRetryApproval`, read off
`session.approvalPolicy` and this same flag): a host that cannot answer gets
the denial as the run's `request.decided` row, with no listener of its own.
The `@texra-ai/harness` package's sessions rely on that, and the headless CLI
answers what its policy leaves open from a terminal prompt
(`createHeadlessCliHostInteractions`,
`packages/cli/src/runtime/approvalAdapter.ts`).

The same holds for a plan, a delegation proposal and a question
(`policyDecidedRows` in `packages/harness/src/agent/runtime/requestPolicy.ts`,
whose rows `session.requests.ask` commits beside the `request.opened`).

### What ends a wait without a decision

Stopping the run (`session.runs.stop(runId)`, with the id
`RootLaunchOptions.onRun` hands over; `packages/harness/src/agent/runtime/runs.ts`) ends
the run. A request opened through `SessionHandle.openRequest` (a command, an
edit, a plan, a delegation, a question) is closed by the interruption: it
commits `request.decided` with `{ action: 'cancel', cause: 'Run interrupted.' }`
(`packages/harness/src/agent/runtime/SessionHandle.ts:706-788`). A loop-owned `retry` request
is not opened there, and no such row is written for it, so an unanswered
`retry` stays listed until a `request.decided` resolves it
(`projectRequests`, `packages/harness/src/shared/session/sessionViewUpdate.ts`, rebuilds a
run's list from its unresolved rows). Stopping is the cancellation path, not a
substitute for answering a run that should continue.

### Why the flag is the host's, and the answer is the session's

A request is a durable row, answerable by any surface that folds the session
— the TUI, a reattached desktop window, a resumed process. A session with no
host attached says nothing about whether a surface is coming — it could not
tell a session nobody watches from one whose surface has not attached yet —
so the session never settles a request on that ground. The caller states it:
a host attached with `approvalPromptsUnavailable: true` says nobody will
answer, and the session's approval policy then decides every request it can
when it opens.

---

## 4. What degrades gracefully (safe to skip)

- **`skills` (`Composition.skills`, `ProcessLayerOptions.skills`):** Runtime
  skills degrade to an empty catalog: with no skill sources the process's
  `HostSkillSources` holds no contributions, the fold yields no sources and
  discovery finds nothing (`packages/harness/src/skills/runtimeSkills.ts`).
  Given a resources tree, the process also reads each of its plugins'
  bundled skills under `<resourcesPath>/plugins/<id>/skills` (today `lean4`
  and `multi-agent`).
- **`seedDisabledToolDefaults(key)`:** No first-install tool defaults are
  written, so no plugin whose switch starts `off` is default-disabled. More tools
  are available, not fewer (`packages/harness/src/tools/toolAvailability.ts:77-95`).
- **`lean: directLeanLanguageServices()`:** The raw loop still runs over any
  `LeanLanguageServices` layer; without the direct one, Lean tools reach
  whatever port the embedder passed. The `memory`/`plan` injections do not
  depend on this choice (`packages/harness/src/tools/plugins.ts`).

The installed `AgentDirectoriesPort` is the whole of the core agent bundle:
`AgentDirectoryService` resolves `builtIn()` inside the
`resourcesPath` it was given and the files are read where they sit, so a port
pointed at a tree that does not hold them leaves the `AgentCatalog` with no
packaged agents (§2). Tool plugins that ship agents (today `lean4`) keep them at
`<resourcesPath>/plugins/<id>/agents`, and the `builtIn` scan adds the
directory of each plugin in the process's `ToolRegistry` that is on, under the
port's `resourcesRoot` (`enabledBuiltInRoots`,
`packages/harness/src/agent/index/BundledAgentDirectories.ts`). A port with no
`resourcesRoot` drops the Lean agents and nothing else.

---

## 5. Reading the CLI: obligations vs. product features

`initCliPlatform` (`packages/cli/src/runtime/initPlatform.ts:280-463`) is one
Effect program that builds the process runtime, the process roots and the
process session, and every `texra` command runs it. An embedder reading it cannot tell
which steps are runtime requirements and which are `texra`-the-product. The
following classification makes that distinction.

### Runtime bootstrap and shipped-feature parity

- **`:297-306` — `installCliProcessRuntime(...)`:** Required. The one process
  runtime, a `ManagedRuntime` over `processLayer`
  (`packages/cli/src/runtime/cliProcessRuntime.ts:242-246`), which also
  builds the agent-directories port (`:230-241`) and passes the runtime
  skill sources. The `lean4` plugin's direct Lean language-server pool
  (`packages/texra/src/tools/lean/direct/directLspAdapter.ts`) is shipped-feature parity, not a raw-loop requirement; a composition may
  leave the plugin out. The `memory` and `plan` injections are manifest data
  (`packages/harness/src/tools/plugins.ts`).
- **`:352-361` — `createNodeWorkspaceRoots(...)`:** Required. The workspace
  roots every session is opened over.
- **`:395` — `bootstrapHost({ roots })`:**
  The shared once-per-process write every host runs beside its runtime
  (`packages/texra/src/controllers/hostBootstrap.ts:46-54`): the
  first-install disabled-tool seed. (The runtime skill sources and the model HTTP dispatcher are
  `processLayer()`'s own; `Sessions.layer` never sets the dispatcher.) An embedder that skips it gets a runtime
  without the seed, not a broken one. The CLI runs it before publishing its roots
  so the fallible seed fails while they are still private.

### CLI initialization choices — not runtime obligations

- **`:340-346` — `StateStores.project(...)` and `StateStores.repo(...)`:** The
  CLI's own on-disk workspace state stores under its storage root. An embedder supplies its own
  stores to `createNodeWorkspaceRoots`.
- **`:366-388` — the memoized session open:** Opens the process session lazily
  (`Sessions.open(roots, { persistent: true, … })`), so a command that needs
  no session never opens one. An embedder calls `Sessions.open` directly (§1,
  Prerequisite A).
- **The shutdown scope (`initCliPlatform`):** The process's shutdown is one
  scope's close. Its finalizers run in reverse of registration: every
  session closes (`Sessions.closeAll`, which stops and settles its runs,
  killing agent-spawned OS children with them, and flushes its artifacts),
  then the project scope with a final NDJSON flush, then the runtime.
  Recommended for any long-lived process that runs `bash` tools; an embedder
  holds the same order in its own scope, closing sessions before it disposes
  the runtime.
- **`installCliShutdownSignalHandlers()`:** SIGINT/SIGTERM handling for a
  terminal process, which closes that scope.

### Cross-check against desktop

The desktop main process makes the same runtime choices, showing how a shipped
host obtains full feature parity rather than proving that every call is a
minimum runtime requirement: it builds its agent-directories port at
`packages/desktop/src/main/platform/index.ts:102-113`, passes the same
skill sources to its `processLayer` and runs the same `bootstrapHost` at
`:164`. Product policy is not necessarily CLI-only: the disabled-tool seed
reaches both hosts through that one shared call, and the skill sources
through the one `processLayer` option, rather than being repeated per host.

---

## 6. Known sharp edges

1. **Only part of the shipped ordering is immediately load-bearing.** Step 3's
   port is served by the Step 1 install, so it is built first. Feature-parity
   registration stores a Lean adapter without evaluating host services, and
   the injections are manifest data; the process runtime is needed only when
   a run later reads the memory setting
   (`packages/harness/src/tools/plugins.ts`;
   `packages/texra/src/tools/lean/direct/directLspAdapter.ts:47-52`).
2. **The process runtime is once-per-process.** The Lean layer is built with
   it and closed with it; a host passes it in the plugin list it hands
   `processLayer` (`packages/harness/src/effect/processLayer.ts`).
3. **The agent catalog is process-wide**, not session-scoped (the process's
   `AgentCatalog` service, `packages/harness/src/agent/index/agentCatalog.ts`). There is no per-embedder agent
   namespace.
4. **One session per storage root.** `SessionOwner.open`
   (`packages/harness/src/platform/processRuntime.ts`) returns the session
   already open over the same root, built from what its first opener
   supplied. Embedding inside a process that already hosts TeXRA shares that
   session.
5. **Some failure modes cluster at run time, not startup.** Skipping
   `AgentCatalog.refresh` is harmless: the catalog loads on the first miss.
   Resolution fails for an agent no source holds (`AgentNotFound`), a load
   that fails (`AgentCatalogLoadError`), or a failed workspace-state read
   (`StateReadFailed`). A request nobody decides parks
   the run mid-way (§3). None of these fails fast at bootstrap.

## 7. Related documents

- `2026-07-09-agent-sdk-north-star.md` — NS-4 (`:79-85`,
  `:164`) is the item this document discharges. Its acceptance table
  (`:166-176`, rows at `:170-171`) counts "Ordered post-init registrations to first run: 9-10,
  untyped" and "Deep imports for a minimal embedder: ~20 modules"; §1 and §5
  above are the concrete baseline those metrics need.
- `2026-07-09-state-of-the-architecture.md:815-826` — the NS-4
  finding, including the empty-`builtIn()` trick and the residual unknown about
  hard-required built-in agent names.
- `docs/architecture/2026-06-20-agent-trace.md` — the run-scoped event channel an embedder
  reads for progress.
