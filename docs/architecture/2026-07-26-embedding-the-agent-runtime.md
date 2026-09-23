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
snapshots. Where the code is awkward, this note says so rather than describing
an intended future shape.

---

## 1. The minimum sequence to a working `runAgent`

The sections below separate minimum launch requirements from shipped-feature
parity. A raw agent loop needs an initialized platform, usable credentials,
agent directories, a session, and a populated registry. When response-bearing
interactions are possible, the session also needs an interactions attachment;
there is no separate presentation-host argument. The direct Lean language
services the shipped Node hosts pass to `installProcessRuntime` are a
shipped-feature choice; the raw loop only needs some `LeanLanguageServices`
layer there.

### Step 1 — `initPlatform({ lifecycle, agentDirectories })`

`platform()` throws until this runs (`src/platform/platform.ts:68-75`).
`initPlatform` itself just freezes and stores the services object
(`src/platform/platform.ts:60-62`).

There is no `createNodePlatform` factory any more, and no list of eight further
services to fill in. `Platform` has shrunk onto two required members plus one
optional one (`src/platform/platform.ts:39-52`):

```ts
interface Platform {
  readonly lifecycle: LifecycleHost;
  readonly agentDirectories: AgentDirectoriesPort;
  readonly toolMissingHandler?: (
    message: string,
    openDocsCommand?: string,
  ) => void | Promise<void>;
}
```

Everything the old factory supplied moved to one of two owners, and an embedder
supplies each one there rather than in the platform literal:

- **Process services** (the filesystem, `Path`, secrets, application state, the
  resume port, the editor language-model bridge) are Effect services provided
  once per process by `installProcessRuntime`
  (`src/controllers/session/sessionLayer.ts:1055-1069`).
- **Per-workspace services** (the workspace root, its storage paths, its
  configuration and its state stores) are a `WorkspaceRoots`
  (`@platform/workspaceRoots`) carried by each `SessionHandle`, so one process
  can hold sessions rooted in several folders. Build one with
  `createNodeWorkspaceRoots` (`src/platform/defaults/nodeHost.ts:59-76`), which
  canonicalizes the workspace path and picks the config provider.

`agentDirectories` is the port that names the three directories the registry
scans. `createPlatformAgentDirectories`
(`src/agent/index/platformAgentDirectories.ts:20-33`) builds one over a
packaged resources tree; its `builtIn()` and `builtInToolUse()` read that tree
in place. Nothing is copied into global storage, so there is no bundle-copy
step to run and no version state key to keep.

Beside the platform, a Node root calls `bootstrapHost`
(`src/controllers/hostBootstrap.ts:75-92`) once, on its own process runtime: it
installs the model HTTP dispatcher, the process setting host, the account
probes, the runtime skill sources, and the first-install disabled-tool seed.
An embedder that skips it gets a runtime without those, not a broken one.

Only a composition root calls `initPlatform`; that rule is stated in the
`nodeHost` module header (`src/platform/defaults/nodeHost.ts:1-18`).

### Feature-parity step — the `lean` layer of `installProcessRuntime`

`src/tools/lean/direct/directLspAdapter.ts`. The Node hosts pass exactly one
layer:

```ts
installProcessRuntime({ /* … */, lean: directLeanLanguageServices() });
```

The two conditional tool injections — `memory` and the unified `plan` tool
that drives the goal loop — are not part of this step: they self-register when
`src/agent/runtime/toolInjection.ts` loads. Registration only stores
predicates: the memory setting is read later, when its predicate is evaluated.
The platform must merely exist before injected tools are resolved.

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
const agentDirectories = createPlatformAgentDirectories({
  channel: 'my-embedder',
  resourcesPath, // dir containing agents/, tool_use_agents/, skills/
  customDirectoryStore: { get: () => Effect.succeed(undefined) },
});
initPlatform({ lifecycle, agentDirectories });
```

`customDirectoryStore.get()` yields the user-configured custom agent
directory, or `undefined` for none. The three methods return Effects, not Promises
(`src/agent/index/AgentDirectoryService.ts:61-85`); a failure to resolve a
directory is an `AgentDirectoriesFailed`, and the `issueReporter` option
decides how it surfaces (the default logs it at `warn`).

Alternatively, skip the packaged tree entirely and hand `initPlatform` an
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
Pass `{ includeRemote: false }` unless you want the Supabase remote-agent
catalog.

### Per-session — attach host interactions when presentation is required

`runAgent` and `executeAgent` obtain presentation and approval behavior from
the selected session's stable `SessionHostInteractions` object. A host attaches
its adapter with `session.interactions.use(...)` and detaches that adapter
when the host presentation lifetime ends. `use` returns an `Effect` that
yields the detach disposer, so it is `yield*`ed. The attachment answers
nothing: every request a run makes of a person (retry, question, approval) is
a `request.opened` row the run's fold lists, closed by the
`request.decided` row a surface's decision commits
(`src/agent/runtime/HostInteractions.ts:85-91`). An unanswered request stays
parked on its row. The adapter in the example below only receives
presentation events, and `approvalPromptsUnavailable` (§3) keeps the
approval-gated tools away from the model.

### Putting it together

This example assumes an alias-aware build from a TeXRA checkout, as described
at the start of this document. Copying these imports into an ordinary external
TypeScript project and running plain `tsc` is insufficient: there are no
runtime packages named `@platform/platform`, `@agent/runtime/runAgent`, and so
on.

```ts
import { Effect } from 'effect';
import { initPlatform } from '@platform/platform';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { bootstrapHost } from '@controllers/hostBootstrap';
import { loadAgents } from '@agent/index/agentRegistry';
import { initializeDefaultSession } from '@agent/runtime/sessionGraph';
import { runAgent } from '@agent/runtime/runAgent';
import { validateRunRequest } from '@agent/core/state/runRequests';
import { AgentCategory } from '@shared/schemas/agent';

// Step 1 — the platform is two members; everything else has another owner.
const lifecycle = createLifecycleHost();
const agentDirectories = createPlatformAgentDirectories({
  channel: 'my-embedder',
  resourcesPath, // dir containing agents/, tool_use_agents/, skills/
  customDirectoryStore: { get: () => Effect.succeed(undefined) },
});
initPlatform({ lifecycle, agentDirectories });

// The process services: filesystem, secrets, application state, and the rest.
const runtime = installProcessRuntime({
  processStart: nodeProcesses.selfIdentity(),
  globalStorage,
  secrets,
  appState: globalState,
  /* …the other process services… */
  lean: directLeanLanguageServices(), // Shipped-feature parity
});

// The per-workspace services, carried by the session rather than the platform.
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
    // Everything a TeXRA process installs once beside its platform.
    yield* bootstrapHost({
      host: 'cli',
      roots,
      secrets,
      skills: { resourcesPath },
    });

    const session = yield* initializeDefaultSession({ roots });
    const detachHostInteractions = yield* session.interactions.use({
      emit: (event, payload) => {
        console.error(`[texra] ${event}`, payload);
      },
    }); // see §3 — DO NOT SKIP
    yield* loadAgents({ includeRemote: false });

    const validated = validateRunRequest({
      config: {
        agent: 'assistant',
        agentCategory: AgentCategory.ToolUse,
        instruction: 'Hello',
      },
    });
    if (!validated.valid) throw new Error(validated.message);

    yield* Effect.ensuring(
      runAgent(validated.request, {
        session,
        approvalPromptsUnavailable: true,
      }),
      Effect.sync(detachHostInteractions),
    );
  }),
);
```

`validateRunRequest` (`src/agent/core/state/runRequests.ts`)
is the result-style validation helper: it returns either a
`ValidatedExecutionRequest` or a validation message. A caller that prefers
exceptions may instead run `AgentConfigSchema.parse` and construct the
`ValidatedExecutionRequest` structurally, as production extension callers do
(`packages/extension/src/commands/agent/executeCommand.ts:37-46`;
`packages/extension/src/frontend/review/AgentReviewService.ts:328-347`).
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
  `createPlatformAgentDirectories({ channel: 'cli', customDirectoryStore: … })`
  (`packages/cli/src/runtime/cliProcessRuntime.ts:246-250`,
  `src/agent/index/platformAgentDirectories.ts:25-57`). An embedder is free to
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

## 3. The headless minimum for interactions — the one section to read

**A host must answer every blocking request its runs can raise. Attaching
nothing, or attaching a host that omits the method a run calls, parks that
run.** The mostly-optional method signatures suggest otherwise, and this is
the single highest-consequence fact in this document.

### The mechanism

Every blocking interaction goes through `SessionHostInteractions.enqueue`
(`src/agent/runtime/HostInteractions.ts:784-814`), which adds the pending
record to `this.pending` and then calls `dispatch`:

```ts
// src/agent/runtime/HostInteractions.ts:811-812
this.pending.add(pending);
this.dispatch(pending);
```

`dispatch` starts with:

```ts
// src/agent/runtime/HostInteractions.ts:901-906
private dispatch(pending: PendingSessionInteraction): void {
  const attachment = this.activeAttachment;
  if (!attachment) {
    this.warnParked(pending);
    return;
  }
```

The pending promise has already been created and registered. With no
attachment, `dispatch` logs a warning and returns **without settling it**.

With an attachment whose method is simply _omitted_, the optional call yields
`undefined`, and the next branch settles only a request that names no run
(`src/agent/runtime/HostInteractions.ts:914-933`):

```ts
if (!result) {
  if (pending.fact) {
    // run-scoped: stays pending for a decision on its approval row
    return;
  }
  this.deletePending(pending);
  pending.settle(pending.cancellationResult());
  return;
}
```

A run-scoped request stays pending until a surface settles it through the
session (`settleRequest` / `settleRetry`), a cancel reaches it, or the session
is disposed. For an embedder with no surface, that is a hang.

Nothing in the runtime attaches interactions for you. A fresh `SessionHandle`
constructs an empty `SessionHostInteractions`
(`src/agent/runtime/SessionHandle.ts:165`), and hosts call `.use(...)` on it
directly (`SessionHostInteractions.use`,
`src/agent/runtime/HostInteractions.ts:429`). The former
`SessionHandle.useHostInteractions` pass-through was deleted in #11380.

### The affected calls

Six request kinds park when unattached or unanswered —
`requestToolEditApproval`, `requestBashApproval`, `requestPlanApproval`,
`requestAgentProposal`, `requestRetry`, `askUserQuestion`
(`src/agent/runtime/HostInteractions.ts:564-630`).

`openExternalInquiry` is deliberately excluded: it reads
`this.activeAttachment?.interactions.openExternalInquiry?.(request)` directly
(`src/agent/runtime/HostInteractions.ts:632-641`), and its comment explicitly
says this is to avoid "parking the agent while no UI is attached".

### Escape hatches, and why they are not a substitute

- **Attaching later unblocks.** `use()` calls `activateCurrentAttachment`,
  which redispatches everything still pending
  (`src/agent/runtime/HostInteractions.ts:621-639`). Parking is not permanent
  _if_ a host eventually attaches.
- **Interrupting a retained run handle settles pending interactions.**
  `RunAgentOptions.onRun` exposes an `AgentRunHandle`
  (`src/agent/runtime/runAgent.ts:31-46`;
  `src/agent/runtime/RunHandle.ts`). Retain it and call
  `handle.interrupt()` to abort the run; both workflow and tool-use
  interruption call `runSession.interactions.cancel`
  (`src/agent/runtime/executeAgent.ts`; `src/agent/runtime/loop/toolUse.ts`).
  This is the supported cancellation path, not a substitute for attaching a
  host to a run that should continue.
- **Direct `cancel()` / `dispose()` also settle without an attachment.**
  `cancel` falls through to `settleFallbacks()` synchronously when there is no
  active attachment (`src/agent/runtime/HostInteractions.ts:549-555`), and
  `dispose()` settles anything still owned
  (`src/agent/runtime/HostInteractions.ts:558-589`). These direct methods are
  available to an embedder that owns the session.
- **`approvalPromptsUnavailable: true` narrows the problem, it does not solve
  it.** That option filters `requiresApproval` tools out of the model-facing
  tool list before invocation
  (`src/agent/runtime/agentToolResolution.ts:150-157`, threaded through
  the run's `AgentRun` service, `src/agent/runtime/run/AgentRun.ts`). It does not
  touch `requestRetry` or `askUserQuestion`, and it does not change dispatch.
  The CLI sets it for `policy === 'never'` and for headless `ask`
  (`packages/cli/src/runtime/approval/settleApprovals.ts` —
  `cliApprovalPromptsUnavailable`) _in addition
  to_ attaching real interactions.

### The typed shape

`cancel` is the one **required** member of `HostInteractions`
(`src/agent/runtime/HostInteractions.ts:389`); every other member — the seven
request methods plus `emit`, `dispose`, the diagnostics readers, and
`setApprovalBypassState` — is optional
(`src/agent/runtime/HostInteractions.ts:347-390`). So the compiler forces you
to write `{ cancel: … }`, and nothing more. The trap is not a badly-typed
object: it is **never calling `interactions.use`**, or attaching a host that
omits a request method a run will call. No type catches either.

### The headless embedder contract (issue #9256)

Issue #9256 asked what a session should do when no interaction host is ever
attached at all. The ruling: **no runtime semantic change.** Parking (above)
stays — it is what lets a desktop per-window reattach pick up a request that
parked before it attached — and the runtime installs no default attachment.
Instead, the contract is on the caller: attach a host that answers each
request kind a run can raise, and use `approvalPromptsUnavailable: true` to
remove the approval kinds, the most common ones. The flag does not reach
`requestRetry`, so a headless host answers it itself; the package's own
headless host denies it (`packages/agent/src/effect/sessions.ts:199-213`).

**`approvalPromptsUnavailable: true` is the real headless answer for that
case**, not merely a partial mitigation: an agent that cannot be asked simply
is not given the tools that require asking, which is a defined, loud
degradation instead of a hang. Trace the wiring end to end:

- `executeAgent` threads `options.approvalPromptsUnavailable` into the run
  context on both a fresh launch and a resume
  (`src/agent/runtime/executeAgent.ts:392-396`, `:547-550`).
- The run layer reads it off the launch context's tool policy and forwards it
  to tool resolution (`src/agent/runtime/run/AgentRun.ts`).
- `resolveAgentTools`'s shared gate drops any tool with
  `requiresApproval: true` once the flag is set, before the model ever sees it
  in its tool list (`src/agent/runtime/agentToolResolution.ts:150-157`).

The worked example is the CLI's own headless path: it derives the flag from
policy and mode (`packages/cli/src/runtime/approval/settleApprovals.ts` —
`cliApprovalPromptsUnavailable`)
and passes it straight into the real `runAgent` call
(`packages/cli/src/runtime/executeCli.ts`). As the "Escape hatches"
note above says, the flag does not touch `requestRetry` or `askUserQuestion`
dispatch — it only narrows which tools can raise the approval kinds that were
the reachable hang.

**The diagnostic for getting it wrong anyway:** an unattached `dispatch` logs
a warning before returning, naming the parked request kind and run and
prescribing a host that answers requests
(`src/agent/runtime/HostInteractions.ts:901-906` calls `warnParked`, defined
at `:947-958`). A request parked because the attached host omits its method
is logged at `info` (`:914-924`).

**Why there is no runtime default.** `activeAttachment` is the most recently
attached host (`this.attachments.at(-1)`,
`src/agent/runtime/HostInteractions.ts:573-575`); detaching reactivates
whatever is left, or re-parks anything still pending if nothing is
(`:381-389`, `:603-626`). A permanent default-denier occupying that stack
would instead settle every live approval the instant the real host detached —
and desktop attaches and detaches per window, one `DesktopProgressBridge`
per `BrowserWindow` calling `interactions.use` on the one process-owned
session and disposing it on close
(`packages/desktop/src/main/desktopAgentRun.ts`;
`packages/desktop/src/main/index.ts:583-621`). Closing one window would
silently deny a pending tool-edit diff. A latch that auto-denies before any
host has ever attached fares no better: the runtime cannot know whether a
UI is coming; the caller can, and `approvalPromptsUnavailable` is how it
says so.

---

## 4. What degrades gracefully (safe to skip)

- **`initializeNodeRuntimeSkills({…})`:** Runtime skills degrade to an empty
  catalog: `if (sources.length === 0) return { catalog: '', issues: [] };`
  (`src/skills/runtimeSkills.ts:57-59`; registration at
  `src/platform/defaults/nodeHost.ts:157-169`).
- **`seedDisabledToolDefaults(key)`:** No first-install tool defaults are
  written, so no toggleable external tools are default-disabled. More tools
  are available, not fewer (`src/tools/toolAvailability.ts:77-95`).
- **`lean: directLeanLanguageServices()`:** The raw loop still runs over any
  `LeanLanguageServices` layer; without the direct one, Lean tools reach
  whatever port the embedder passed. The `memory`/`plan` injections do not
  depend on this choice (`src/agent/runtime/toolInjection.ts`).

There is no separate agent-bundle bootstrap to run or skip. The installed
`AgentDirectoriesPort` is the whole of it: `createPlatformAgentDirectories`
resolves `builtIn()` and `builtInToolUse()` inside the `resourcesPath` it was
given and the files are read where they sit, so a port pointed at a tree that
does not hold them leaves `loadAgents` with no packaged agents (§2).

---

## 5. Reading the CLI: obligations vs. product features

`initCliPlatform` (`packages/cli/src/runtime/initPlatform.ts:256-467`) is one
Effect program that builds the process runtime, the platform and the process
session, and every `texra` command runs it. An embedder reading it cannot tell
which steps are runtime requirements and which are `texra`-the-product. The
following classification makes that distinction.

### Runtime bootstrap and shipped-feature parity

- **`:275-282` — `installCliProcessRuntime(...)`:** Required. The one process
  runtime (`packages/cli/src/runtime/cliProcessRuntime.ts:251`), which also
  builds the lifecycle host and the agent-directories port
  (`:246-250`). Its `lean: directLeanLanguageServices()` (`:298`) is
  shipped-feature parity, not a raw-loop requirement; an embedder may pass
  another layer. The `memory` and `plan` injections self-register
  (`src/agent/runtime/toolInjection.ts`).
- **`:326-333` — `createNodeWorkspaceRoots(...)`:** Required. The workspace
  roots every session is opened over.
- **`:370-378` — `bootstrapHost({ host: 'cli', roots, secrets, skills })`:**
  The shared once-per-process install every host runs beside its platform
  (`src/controllers/hostBootstrap.ts:75-92`): the model HTTP dispatcher, the
  process setting host, the account probes, the runtime skill sources, and the
  first-install disabled-tool seed. An embedder that skips it gets a runtime
  without those, not a broken one. The CLI runs it before `initPlatform` so
  the fallible seed fails while the platform is still private.
- **`:400` — `initPlatform(platform)`:** Required. `platform()` throws
  otherwise (`src/platform/platform.ts:68-75`).

### CLI initialization choices — not runtime obligations

- **`:308-311` — `openCliWorkspaceState(...)`:** The CLI's own on-disk
  workspace state stores under its storage root. An embedder supplies its own
  stores to `createNodeWorkspaceRoots`.
- **`:340-363` — the memoized session open:** Opens the process session lazily,
  with the LaTeX response-text connector as its `responseTextProcessing`, so a
  command that needs no session never opens one. An embedder calls
  `initializeDefaultSession` directly (§1, Prerequisite A).
- **`:386-398` — `registerRuntimeShutdownHandlers(lifecycle, …)`:** Drains
  agent-spawned OS children, flushes session publications, and disposes the
  runtime on shutdown. Recommended for any long-lived process that runs `bash`
  tools; its hook record names CLI-owned resources.
- **`:403-405` — `installCliShutdownSignalHandlers(lifecycle)`:** SIGINT/SIGTERM
  handling for a terminal process.
- **`:460-463` — `initializeCliSupabaseAuth(...)`:** Supabase sign-in wiring
  for the CLI's authentication flow.

### Cross-check against desktop

The desktop main process makes the same runtime choices, showing how a shipped
host obtains full feature parity rather than proving that every call is a
minimum runtime requirement: it builds its agent-directories port at
`packages/desktop/src/main/platform/index.ts:167`, runs the same
`bootstrapHost` at `:228`, and calls `initPlatform({ lifecycle,
agentDirectories })` at `:234`, after it rather than before. Product policy is
not necessarily CLI-only: the disabled-tool seed and the runtime skill sources
reach both hosts through that one shared call rather than being repeated per
host.

---

## 6. Known sharp edges

1. **Only part of the shipped ordering is immediately load-bearing.** Step 3
   reads `platform()`, so Step 1 must precede it; nothing checks this beyond the
   throw in `platform()` itself. Feature-parity registration stores
   predicates and a Lean adapter without evaluating host services; the
   platform is needed only when the memory predicate later runs
   (`src/agent/runtime/toolInjection.ts`;
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
   `loadAgents` throws at agent resolution, and a missing interactions
   attachment, or a host that omits a request method the run calls, parks the
   run mid-way. Neither fails fast at bootstrap.

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
