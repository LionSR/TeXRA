# Embedding the TeXRA Agent Runtime

**Status: internal. Not published on texra.ai.** There is no `@texra/core`
package and no SDK surface; everything below is a deep import through the
repo-root path aliases declared in `tsconfig.json`. Plain `tsc` output does not
rewrite those aliases. An external program must therefore build from a TeXRA
checkout with equivalent alias-aware bundler configuration, or replace the
aliases with resolvable paths. The repository's Vite builds derive their alias
map from `tsconfig.json` (`scripts/aliases.mjs:14-20`,
`packages/extension/vite.config.mts:5`), while the extension's esbuild bundle
reads its package tsconfig, which extends the root one (`packages/extension/esbuild.config.mjs:34-48`).
Nothing here is a stable contract — this note documents what an external
program has to do _today_ to get a `runAgent` call to complete, so that SDK work
has a measurable baseline.

Every claim below is cited to `file:line`. The original baseline was verified
at the PR base (`5fc03f9436`); review corrections were rechecked against
`origin/main` (`97543989b5`). None of the 50 cited files changed between those
snapshots. §1, §2, §3 and §5 were rewritten against `main` at `bac10c1` for
#12950, after the request model and the host bootstrap moved. Where the code is
awkward, this note says so rather than describing an intended future shape.

---

## 1. The minimum sequence to a working `runAgent`

The sections below separate minimum launch requirements from shipped-feature
parity. A raw agent loop needs an installed process runtime, usable credentials,
agent directories, a session, and a populated registry. When a run can open
requests, something must also decide them (§3); presentation goes through the
session's interactions attachment, and there is no separate presentation-host
argument. The direct Lean language
services the shipped Node hosts pass to `installProcessRuntime` are a
shipped-feature choice; the raw loop only needs some `LeanLanguageServices`
layer there.

### Step 1 — `installProcessRuntime({ agentDirectories, … })`

There is no `createNodePlatform` factory and no process-wide platform object
any more: the `Platform` module was deleted (#13060). Every process fact has
one of two owners, and an embedder supplies each one there:

- **Process services** (the `agentDirectories` port,
  the optional `toolMissingReporter`, the filesystem, `Path`, secrets,
  application state, the resume port, the editor language-model bridge) are
  Effect services provided once per process by `installProcessRuntime`
  (`src/controllers/session/sessionLayer.ts`).
- **Per-workspace services** (the workspace root, its storage paths, its
  configuration and its state stores) are a `WorkspaceRoots`
  (`@platform/workspaceRoots`) carried by each `SessionHandle`, so one process
  can hold sessions rooted in several folders. Build one with
  `createNodeWorkspaceRoots` (`src/platform/defaults/nodeHost.ts:59-76`), which
  canonicalizes the workspace path and picks the config provider.

`agentDirectories` is the port that names the three directories the registry
scans. `new AgentDirectoryService({...})`
(`src/agent/index/AgentDirectoryService.ts:58-60`) builds one over a
packaged resources tree; its `builtIn()` and `builtInToolUse()` read that tree
in place. Nothing is copied into global storage, so there is no bundle-copy
step to run and no version state key to keep.

Beside that install, a Node root calls `bootstrapHost`
(`src/controllers/hostBootstrap.ts:75-92`) once, on its own process runtime: it
installs the model HTTP dispatcher, the process setting host, the account
probes, the runtime skill sources, and the first-install disabled-tool seed.
An embedder that skips it gets a runtime without those, not a broken one.

Only a composition root calls `installProcessRuntime`; ESLint pins the import
to the files in `COMPOSITION_ROOT_FILES` (`eslint.config.mjs`).

### Feature-parity step — the `lean` layer of `installProcessRuntime`

`src/tools/lean/direct/directLspAdapter.ts`. The Node hosts pass exactly one
layer:

```ts
installProcessRuntime({ /* … */, lean: directLeanLanguageServices() });
```

The two conditional tool injections — `memory` and the unified `plan` tool
that drives the goal loop — are not part of this step: they are data on the
memory-workflow plugin (`injectedWhen` in `src/tools/plugins.ts`), and their
settings are read when a run resolves its tools against the `ToolRegistry`
table the process runtime provides.

The pool the layer builds spawns nothing until a Lean tool is first used, and
its servers stop when the process runtime is disposed.

An embedder with its own Lean integration passes `LeanLanguageServices.layer`
over it instead; the `memory` and `plan` injections are present either way.

### Step 2 — credential resolution

There is no model-access bootstrap call. A run binds its model through
`src/agent/runtime/run/modelBinding.ts`, which resolves the route's credential
in `src/agent/runtime/modelRoutes.ts` (`resolveRouteCredential` for API keys,
`resolveSubscriptionCredential` for the ChatGPT and Grok subscriptions).

Credential resolution uses the caller's own provider API keys or subscription
credentials only; there is no server-side model access to configure. A
stateless BYOK embedder needs no auth setup at all — a host that wants
persisted state (settings, credentials) must complete Step 1 before the first
model call.

### Step 3 — agent directories

To use the packaged agent definitions, install a port that names the tree they
sit in. There is no copy step: `builtIn()` and `builtInToolUse()` resolve
inside `resourcesPath`, and the files are read where they are.

```ts
const agentDirectories = new AgentDirectoryService({
  channel: 'my-embedder',
  resourcesPath, // dir containing agents/, tool_use_agents/, skills/
  customDirectoryStore: { get: () => Effect.succeed(undefined) },
});
// Served as `AgentDirectories` by the Step 1 install:
// installProcessRuntime({ …, agentDirectories: AgentDirectories.layer(agentDirectories) });
```

`customDirectoryStore.get()` yields the user-configured custom agent
directory, or `undefined` for none. The three methods return Effects, not Promises
(`src/agent/index/AgentDirectoryService.ts:61-85`); a failure to resolve a
directory is an `AgentDirectoriesFailed`, and the `issueReporter` option
decides how it surfaces (the default logs it at `warn`).

Alternatively, skip the packaged tree entirely and hand `installProcessRuntime` an
`AgentDirectoriesPort` of your own that points at your directory. See
[§2](#2-agentdirectoriesport-is-three-directory-paths-not-agent-values) — this
is the part the plan of record describes incorrectly.

### Prerequisite A — a default or explicit session

A session is required by `RunAgentOptions.session`. The CLI bootstrap in
`packages/cli/src/runtime/initPlatform.ts` prepares one memoized session-opening
Effect; commands run `services.session` when they need a session. Utility commands
that need no session leave the store unopened.

- `initializeDefaultSession({})` returns an Effect that opens the process-default
  session over the process roots. Run it at the host boundary and pass its handle
  as `options.session`. A second initialization while the session is open fails.
  The CLI and extension supply their `responseTextProcessing` policy here.
- `openSessionEffect({ roots, ... })` opens an owner-held session for explicit
  roots, returning the existing handle when that storage root is already open.
  Pass the handle to `runAgent`; close it through the session owner when its
  lifetime ends.

### Prerequisite B — `yield* loadAgents(...)`

The registry is **not** lazily populated on the run path.
`getAgentPath` → `resolveAgentForLaunch` is a synchronous read of already-loaded
state (`src/agent/index/agentRegistry.ts`); when it misses,
`AgentLaunchContext` emits `showAgentConfigBanner` and throws
`Could not find agent: <name>` (`src/agent/runtime/AgentLaunchContext.ts:158-159`).

`loadAgents` (`src/agent/index/agentRegistry.ts:113-128`) is what fills it.
Neither `runAgent`, `executeAgent`, nor `AgentLaunchContext` populates the
registry, so the caller must ensure that loading has happened before launch.

### Per-session — attach host interactions when presentation is required

`runAgent` and `executeAgent` obtain presentation and approval behavior from
the selected session's stable `SessionHostInteractions` object. A host attaches
its adapter with `session.interactions.use(...)` and detaches that adapter
when the host presentation lifetime ends. `use` returns an `Effect` that
yields the detach disposer, so it is `yield*`ed. The attachment answers
nothing: every request a run makes of a person (retry, question, approval) is
a `request.opened` row the run's fold lists, closed by the
`request.decided` row a surface's decision commits
(`src/agent/runtime/HostInteractions.ts:70-77`). An unanswered request stays
parked on its row. The adapter in the example below only receives
presentation events, and sets `approvalPromptsUnavailable: true` on the
object it passes to `use` (§3), which keeps the approval-gated tools away from the model.

### Putting it together

This example assumes an alias-aware build from a TeXRA checkout, as described
at the start of this document. Copying these imports into an ordinary external
TypeScript project and running plain `tsc` is insufficient: there are no
runtime packages named `@controllers/session/sessionLayer`,
`@agent/runtime/runAgent`, and so on.

```ts
import { Effect, Fiber, Stream } from 'effect';
import { AgentDirectories } from '@platform/interfaces';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import { AgentDirectoryService } from '@agent/index';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { bootstrapHost } from '@controllers/hostBootstrap';
import { loadAgents } from '@agent/index/agentRegistry';
import { initializeDefaultSession } from '@agent/runtime/sessionGraph';
import { runAgent } from '@agent/runtime/runAgent';
import { validateRunRequest } from '@agent/core/state/runRequests';
import { AgentCategory } from '@shared/schemas/agent';

// Step 1 — the process services: agent directories, filesystem, secrets,
// application state, and the rest.
const agentDirectories = new AgentDirectoryService({
  channel: 'my-embedder',
  resourcesPath, // dir containing agents/, tool_use_agents/, skills/
  customDirectoryStore: { get: () => Effect.succeed(undefined) },
});
const runtime = installProcessRuntime({
  processStart: nodeProcesses.selfIdentity(),
  globalStorage,
  secrets,
  agentDirectories: AgentDirectories.layer(agentDirectories),
  appState: globalState,
  /* …the other process services… */
  lean: directLeanLanguageServices(), // Shipped-feature parity
});

// The per-workspace services, carried by the session rather than the process.
const roots = createNodeWorkspaceRoots({
  workspacePath,
  storage,
  globalStorage,
  config,
  workspaceState,
  globalState,
});

await runtime.runPromise(
  Effect.gen(function* () {
    // Everything a TeXRA process installs once beside its process runtime.
    yield* bootstrapHost({
      host: 'cli',
      roots,
      secrets,
      skills: { resourcesPath },
    });

    const session = yield* initializeDefaultSession({ roots });
    const detachHostInteractions = yield* session.interactions.use({
      // §3: this host can answer no approval, so no run of the session is
      // offered a tool that would ask for one.
      approvalPromptsUnavailable: true,
      emit: (event, payload) => {
        console.error(`[texra] ${event}`, payload);
      },
    });
    // §3 — DO NOT SKIP: approvalPromptsUnavailable above removes every tool
    // that opens a request, but a provider failure still opens a `retry`, and
    // nothing answers it unless this process does. Deny each one once.
    const answered = new Set<string>();
    const retryDenier = yield* Effect.forkChild(
      Stream.runForEach(session.viewChanges, (view) => {
        // Forget what the fold no longer lists, so the set tracks only
        // live requests over a long-lived session.
        const live = new Set(view.requests.map((pending) => pending.requestId));
        for (const requestId of answered) {
          if (!live.has(requestId)) answered.delete(requestId);
        }
        return Effect.forEach(
          view.requests.filter(
            (pending) =>
              pending.payload.kind === 'retry' &&
              !answered.has(pending.requestId),
          ),
          (pending) => {
            answered.add(pending.requestId);
            return session.requests
              .request({
                kind: 'request.decide',
                runId: pending.runId,
                requestId: pending.requestId,
                decision: { action: 'deny', reason: 'No retry prompts.' },
              })
              .pipe(
                // A refused write answered nothing: forget the request so
                // the next view denies it again.
                Effect.catch(() =>
                  Effect.sync(() => answered.delete(pending.requestId)),
                ),
              );
          },
          { discard: true },
        );
      }),
    );
    yield* loadAgents();

    const validated = validateRunRequest({
      config: {
        agent: 'assistant',
        agentCategory: AgentCategory.ToolUse,
        instruction: 'Hello',
      },
    });
    if (!validated.valid) throw new Error(validated.message);

    yield* Effect.ensuring(
      runAgent(validated.request, { session }),
      Effect.andThen(
        Fiber.interrupt(retryDenier),
        Effect.sync(detachHostInteractions),
      ),
    );
  }),
);
```

`validateRunRequest` (`src/agent/core/state/runRequests.ts`)
is the result-style validation helper: it returns either a
`ValidatedExecutionRequest` or a validation message. A caller that prefers
exceptions may instead run `AgentConfigSchema.parse` and construct the
`ValidatedExecutionRequest` structurally, as production extension callers do
(`packages/extension/src/commands/agent/executeCommand.ts:37-46`).
`agent`, `model`, and `instruction` all have `.prefault()` defaults
(`src/agent/core/definition/AgentConfig.ts:18,27,28`), and an absent
`agentCategory` normalizes to `Workflow`
(`src/agent/core/definition/AgentConfig.ts:77-88`). The example sets
`AgentCategory.ToolUse` explicitly because `assistant` is loaded from the
tool-use agent directory (`src/agent/index/agentYamlScanner.ts:289-291`);
launch resolution searches only the requested category
(`src/agent/index/agentRegistry.ts:507-521`).

---

## 2. `AgentDirectoriesPort` is three directory paths, not agent values

`.agents/docs/archived/architecture/2026-07-09-agent-sdk-north-star.md:79-85` and
`.agents/docs/archived/architecture/2026-07-09-state-of-the-architecture.md:815-824` present
"inject `AgentDirectoriesPort`" as the answer to "load agent X from a YAML" for
an embedder. That is correct only in a narrow sense, and the phrasing invites a
wrong reading. State it plainly:

```ts
// src/platform/interfaces.ts:230-238
export interface AgentDirectoriesPort {
  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  builtIn(): Effect.Effect<string, AgentDirectoriesFailed>;
  builtInToolUse(): Effect.Effect<string, AgentDirectoriesFailed>;
}
```

Three methods, each yielding a **directory path string**. The port cannot
carry an agent definition, a parsed object, a YAML string, or a virtual
filesystem. Injecting it redirects the scan to _a different real directory on
disk_; that is the entire capability.

### Why in-memory definitions cannot work: two filesystem planes in one function

`loadAgents` calls `doLoad`, which resolves the three paths and hands each to
`scanDirectory` (`src/agent/index/agentRegistry.ts:153,184-186`). Inside
`scanDirectory`:

- **Enumeration** uses the npm `glob` package with **no `fs` option**
  (`src/agent/index/agentYamlScanner.ts:75-80`, import at `:5`). `glob` without
  an injected `fs` reads the real Node filesystem directly.
- **Reading** three lines later goes through Effect's own `FileSystem`, which
  a test or an embedder can back with something other than the real disk.

So one function straddles two filesystem planes. Serving an in-memory
`FileSystem` changes only the _read_ half; `glob` still enumerates the real
disk and finds nothing, so the scan yields zero agents.

### The repo's own tests prove the constraint

`src/test-kernel/agent/AgentRegistry.vitest.ts` installs a fake platform whose
only override is the directory port:

```ts
// src/test-kernel/agent/AgentRegistry.vitest.ts
await installPlatform(
  { workspaceState },
  { agentDirectories: mutableAgentDirectories },
);
```

…and to register a single custom agent it must create a real temp directory and
write a real YAML file:

```ts
// src/test-kernel/agent/AgentRegistry.vitest.ts
const customDir = await mkdtemp(resolve(tmpdir(), 'texra-custom-agent-'));
await writeFile(resolve(customDir, 'chat.yaml'), [...].join('\n'));
…
useAgentDirectories({ custom: () => Effect.succeed(customDir) });
```

Its `builtIn()`/`builtInToolUse()` point at the real repo tree
(`packages/extension/resources/agents`, `…/tool_use_agents`) —
`src/test-kernel/agent/AgentRegistry.vitest.ts`.

If the codebase's own memfs kernel cannot avoid touching real disk to register
one agent, an embedder cannot either.

### What injection _does_ buy you

- **Skipping the packaged bundle.** `scanDirectory` returns no entries for an
  empty path (`src/agent/index/agentYamlScanner.ts:71`), so
  `builtIn: () => Effect.succeed('')` and
  `builtInToolUse: () => Effect.succeed('')` are legal and cheap. This is the
  "empty-builtIn trick" the proposals mention, and it does work. With it you
  can skip the packaged resources tree entirely and point `custom()` at your
  own directory of YAML.
- **Choosing where custom agents live.** The CLI builds its port with
  `new AgentDirectoryService({ channel: 'cli', customDirectoryStore: … })`
  (`packages/cli/src/runtime/cliProcessRuntime.ts:244-248`,
  `src/agent/index/AgentDirectoryService.ts`). An embedder is free to
  supply a three-line literal instead:

  ```ts
  const agentDirectories: AgentDirectoriesPort = {
    custom: () => Effect.succeed('/abs/path/to/my/agents'),
    builtIn: () => Effect.succeed(''),
    builtInToolUse: () => Effect.succeed(''),
  };
  ```

  Note that the built-in tree is where the shipped agents live; emptying it
  means _only_ your YAML is resolvable. Whether any runtime feature hard-requires
  a specific built-in agent name is an open question — the state-of-the-architecture
  note flags it as a residual unknown
  (`.agents/docs/archived/architecture/2026-07-09-state-of-the-architecture.md:825-826`) and this
  document does not resolve it.

**Bottom line for an SDK conversation:** the port is a _directory redirect_,
not a definitions API. "Definitions as values" would be new code, not
documentation.

---

## 3. The headless minimum for requests — the one section to read

**Every request a run opens waits until something writes its decision. The
runtime writes none for you, and attaching host interactions does not answer
anything.** A headless embedder must either remove the requests its runs can
raise or answer them itself. This is the single highest-consequence fact in
this document.

### The mechanism

A run that needs a person commits a `request.opened` row carrying what a
surface shows (a diff, a command, a question) and parks. The row is answered
by a `request.decided` row (`src/shared/schemas/sessionEvent.ts:381-396`).
"Pending" is nothing but the fold: an opened request with no decision is
listed in the session view's `requests`
(`src/shared/session/sessionView.ts:256`;
`src/shared/session/sessionFold.ts:1621-1640`), which a host reads through
`SessionHandle.view` or the level stream `SessionHandle.viewChanges`
(`src/agent/runtime/SessionHandle.ts:208-217`).

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

(`src/shared/session/runtimeRequest.ts:42-52`). The decision lands as the
run's `request.decided` row, and the run continues from it.

`HostInteractions` is not part of this path. It is a presentation port —
events, diagnostics, PDFs, the tool-edit preview a durable payload cannot
carry — and no method on it returns a decision
(`src/agent/runtime/HostInteractions.ts:70-77`). Attaching a host with
`session.interactions.use(...)` is how a host sees what a run does; it never
unparks a run.

### The request kinds

The payload union is the vocabulary: `toolEdit`, `bash`, `retry`,
`proposal`, `planApproval`, `externalInquiry`, `userQuestion`
(`src/shared/schemas/progressView/data.ts:106-128`). Every kind but
`externalInquiry` parks the tool or turn that opened it
(`requestParksItsCaller`, `:144-148`); an external inquiry is answered later
and parks nothing.

### Removing the requests: `approvalPromptsUnavailable`

The host says it by supplying `approvalPromptsUnavailable` on the object it
passes to `session.interactions.use({...})`, as in the §1 example; it is a
field of `HostInteractions` (`src/agent/runtime/HostInteractions.ts:96`), not
an option of `runAgent`, and `RunAgentOptions` has no such property. The
session's `interactions.approvalPromptsUnavailable` getter reads the attached
host's answer (`HostInteractions.ts:264-267`), and it is `false` while no host
is attached. The getter is sampled once when each launch or resume starts:
`executeAgent` copies it into the run's `toolPolicy`
(`src/agent/runtime/executeAgent.ts:356-357`, `:507-508`), and the run keeps
that value, so attaching or detaching a host afterwards does not change the
tools an in-progress run has. When the sampled value is `true`, every
catalog `requiresApproval` tool is withheld from the model before the first
turn, so a run cannot open the requests those tools would raise. Tools an
embedder supplies in `RunAgentOptions.tools` are not withheld: they are
overlaid after the gates (`resolveStepTools`, `agentToolResolution.ts:356-365`)
and the model is offered them, so a run-scoped tool that needs approval is
left to the approval guard, which may deny the call, rather than removed. The
flag is a fact of the session, not a launch option, so a delegated child, which runs on its parent's session, and a run the session
wakes on its own get the same answer. The run layer forwards it to tool
resolution (`src/agent/runtime/run/AgentRun.ts:238-239`), and
`resolveAgentTools` drops the gated tools
(`src/agent/runtime/agentToolResolution.ts:245-249`). The tools that open
`toolEdit`, `bash`, `proposal`, `planApproval`, `externalInquiry` and
`userQuestion` requests all declare `requiresApproval: true`. This is a loud,
defined degradation — an agent that cannot ask is not given the catalog tools
that ask — rather than a hang.

The CLI's hosts answer it from the approval policy
(`cliApprovalPromptsUnavailable`,
`packages/cli/src/runtime/approval/settleApprovals.ts`), through the headless
adapter's getter (`packages/cli/src/runtime/approvalAdapter.ts:320-322`) and the
TUI's.

### Answering the rest: `retry`

`retry` has no tool behind it. The model invoker opens one on a
user-retryable provider failure, so the flag cannot remove it, and a headless
embedder must answer it. The `@texra-ai/agent` package's own sessions do
exactly this: a listener over `viewChanges` denies each pending `retry`
with the decide command above (`denyRetryRequests`,
`packages/agent/src/effect/sessionPrograms.ts:102-142`). It keeps the set of
requests it has answered, prunes it as the fold drops them, and forgets a
request whose decision was refused so a later level denies it again. The worked
example in §1 inlines the same listener.

The headless CLI does the same for every kind, answering from policy first
and from a terminal prompt otherwise
(`createHeadlessCliHostInteractions`,
`packages/cli/src/runtime/approvalAdapter.ts:141`).

### What ends a wait without a decision

Stopping the run (`session.runs.stop(runId)`, with the id
`RunAgentOptions.onRun` hands over; `src/agent/runtime/runRegistry.ts`) ends
the run. A request opened through `SessionHandle.openRequest` (a command, an
edit, a plan, a delegation, a question) is closed by the interruption: it
commits `request.decided` with `{ action: 'cancel', cause: 'Run interrupted.' }`
(`src/agent/runtime/SessionHandle.ts:706-788`). A loop-owned `retry` request
is not opened there, and no such row is written for it, so an unanswered
`retry` stays listed until a `request.decided` resolves it
(`projectRequests`, `src/shared/session/sessionFold.ts:1138-1156`, rebuilds a
run's list from its unresolved rows). Stopping is the cancellation path, not a
substitute for answering a run that should continue.

### Why there is no runtime default

A request is a durable row, answerable by any surface that folds the session
— the TUI, a reattached desktop window, a resumed process. A built-in
decider could not tell a session nobody watches from one whose surface has
not attached yet, and it would answer requests a person was meant to see.
The caller knows which case it is in, and says so by attaching a host that
sets `approvalPromptsUnavailable` plus a decider for `retry`.

---

## 4. What degrades gracefully (safe to skip)

- **`initializeNodeRuntimeSkills({…}, skillPluginIds)`:** Runtime skills
  degrade to an empty catalog: with no installed skill contributions the
  fold yields no sources and discovery finds nothing
  (`installSkillContributions` in `src/skills/runtimeSkills.ts`; registration
  in `src/platform/defaults/nodeHost.ts`). An embedder that does call it must
  pass the ids of the tool plugins that ship skills (`bootstrapHost` passes
  every manifest entry with `skills: true`, today `lean4`); an empty list
  drops those plugins' bundled skills.
- **`seedDisabledToolDefaults(key)`:** No first-install tool defaults are
  written, so no toggleable external tools are default-disabled. More tools
  are available, not fewer (`src/tools/toolAvailability.ts:77-95`).
- **`lean: directLeanLanguageServices()`:** The raw loop still runs over any
  `LeanLanguageServices` layer; without the direct one, Lean tools reach
  whatever port the embedder passed. The `memory`/`plan` injections do not
  depend on this choice (`src/tools/plugins.ts`).

The installed `AgentDirectoriesPort` is the whole of the core agent bundle:
`AgentDirectoryService` resolves `builtIn()` and `builtInToolUse()` inside the
`resourcesPath` it was given and the files are read where they sit, so a port
pointed at a tree that does not hold them leaves `loadAgents` with no packaged
agents (§2). Tool plugins that ship agents (`agents: true`, today `lean4`)
keep them at `<resourcesPath>/plugins/<id>/agents`, and the `builtInToolUse`
scan adds those directories only once
`installPluginAgentDirectories(resourcesPath, agentPluginIds)`
(`src/agent/index/BundledAgentDirectories.ts`) has run, as `bootstrapHost`
does. Skipping it drops the Lean agents and nothing else.

---

## 5. Reading the CLI: obligations vs. product features

`initCliPlatform` (`packages/cli/src/runtime/initPlatform.ts:256-467`) is one
Effect program that builds the process runtime, the process roots and the
process session, and every `texra` command runs it. An embedder reading it cannot tell
which steps are runtime requirements and which are `texra`-the-product. The
following classification makes that distinction.

### Runtime bootstrap and shipped-feature parity

- **`:275-282` — `installCliProcessRuntime(...)`:** Required. The one process
  runtime (`packages/cli/src/runtime/cliProcessRuntime.ts:251`), which also
  builds the agent-directories port
  (`:246-250`). Its `lean: directLeanLanguageServices()` (`:298`) is
  shipped-feature parity, not a raw-loop requirement; an embedder may pass
  another layer. The `memory` and `plan` injections are manifest data
  (`src/tools/plugins.ts`).
- **`:326-333` — `createNodeWorkspaceRoots(...)`:** Required. The workspace
  roots every session is opened over.
- **`:370-378` — `bootstrapHost({ host: 'cli', roots, secrets, skills })`:**
  The shared once-per-process install every host runs beside its runtime
  (`src/controllers/hostBootstrap.ts:75-92`): the model HTTP dispatcher, the
  process setting host, the account probes, the runtime skill sources, and the
  first-install disabled-tool seed. An embedder that skips it gets a runtime
  without those, not a broken one. The CLI runs it before publishing its roots
  so the fallible seed fails while they are still private.

### CLI initialization choices — not runtime obligations

- **`openProjectStateStore(storage.getStoragePath())`:** The CLI's own on-disk
  workspace state stores under its storage root. An embedder supplies its own
  stores to `createNodeWorkspaceRoots`.
- **`:340-363` — the memoized session open:** Opens the process session lazily,
  with the LaTeX response-text connector as its `responseTextProcessing`, so a
  command that needs no session never opens one. An embedder calls
  `initializeDefaultSession` directly (§1, Prerequisite A).
- **The shutdown scope (`initCliPlatform`):** The process's shutdown is one
  scope's close. Its finalizers run in reverse of registration: every
  session closes (`closeAllSessions`, which stops and settles its runs,
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
`packages/desktop/src/main/platform/index.ts:167`, runs the same
`bootstrapHost` at `:228`. Product policy is
not necessarily CLI-only: the disabled-tool seed and the runtime skill sources
reach both hosts through that one shared call rather than being repeated per
host.

---

## 6. Known sharp edges

1. **Only part of the shipped ordering is immediately load-bearing.** Step 3's
   port is served by the Step 1 install, so it is built first. Feature-parity
   registration stores a Lean adapter without evaluating host services, and
   the injections are manifest data; the process runtime is needed only when
   a run later reads the memory setting
   (`src/tools/plugins.ts`;
   `src/tools/lean/direct/directLspAdapter.ts:47-52`).
2. **The process runtime is once-per-process.** The Lean layer is built with
   it and closed with it; a host passes it exactly where it calls
   `installProcessRuntime` (`src/controllers/session/sessionLayer.ts`).
3. **The registry is process-global**, not session-scoped
   (`src/agent/index/agentRegistry.ts:113-128`). There is no per-embedder agent
   namespace.
4. **`initializeDefaultSession` throws when a default is already open over the
   same storage root** (`src/agent/runtime/sessionGraph.ts:313-316`). Embedding
   inside a process that already hosts TeXRA means reusing
   `tryDefaultSession()` or owning your own `SessionHandle`.
5. **Some failure modes cluster at run time, not startup.** A missing
   `loadAgents` throws at agent resolution, and a request nobody decides
   parks the run mid-way (§3). Neither fails fast at bootstrap.

## 7. Related documents

- `.agents/docs/archived/architecture/2026-07-09-agent-sdk-north-star.md` — NS-4 (`:79-85`,
  `:164`) is the item this document discharges. Its acceptance table
  (`:166-176`, rows at `:170-171`) counts "Ordered post-init registrations to first run: 9-10,
  untyped" and "Deep imports for a minimal embedder: ~20 modules"; §1 and §5
  above are the concrete baseline those metrics need.
- `.agents/docs/archived/architecture/2026-07-09-state-of-the-architecture.md:815-826` — the NS-4
  finding, including the empty-`builtIn()` trick and the residual unknown about
  hard-required built-in agent names.
- `docs/architecture/2026-06-20-agent-trace.md` — the run-scoped event channel an embedder
  reads for progress.
