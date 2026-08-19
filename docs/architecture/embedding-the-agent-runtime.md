# Embedding the TeXRA Agent Runtime

**Status: internal. Not published on texra.ai.** There is no `@texra/core`
package and no SDK surface; everything below is a deep import through the
repo-root path aliases declared in `tsconfig.json`. Plain `tsc` output does not
rewrite those aliases. An external program must therefore build from a TeXRA
checkout with equivalent alias-aware bundler configuration, or replace the
aliases with resolvable paths. The repository's Vite builds derive their alias
map from `tsconfig.json` (`scripts/aliases.mjs:14-20`,
`packages/extension/vite.config.ts:39`), while the extension's esbuild bundle
reads its generated package tsconfig (`packages/extension/esbuild.config.mjs:34-48`).
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
there is no separate presentation-host argument. `initNodeAgentRuntime`
supplies the memory/plan injections and Lean integration used by the shipped
Node hosts, but the raw loop can run without those optional features.

### Step 1 — `initPlatform(createNodePlatform(...))`

`platform()` throws until this runs
(`src/platform/platform.ts:73-80`). `initPlatform` itself just freezes and
stores the services object (`src/platform/platform.ts:65-67`).

`createNodePlatform` (`src/platform/defaults/nodeHost.ts:94-118`) fills in the
Node defaults — `nodeFilesystem`, `createNodeWorkspace`, `JsonConfigProvider`,
`nodeFileLocks`, the unavailable language-model port, and the no-op
tool-availability host — and requires the host to supply the rest:
`configStores`, `globalState`, `workspaceState`, `storage`, `secrets`,
`lifecycle`, `agentResume`, `agentDirectories`, `getWorkspacePath`
(`src/platform/defaults/nodeHost.ts:53-69`).

When Step 3 will copy the packaged bundle, `agentDirectories` must be the
matching global-storage port from `createPlatformAgentDirectories`, or an
equivalent port that resolves the same copied directories. The factory and the
bootstrap both use `GlobalStorageAgentDirectoryStorage`
(`src/agent/index/platformAgentDirectories.ts:25-29,59-65`). Bootstrapping
alone does not replace the port already installed in the platform.

Only a composition root calls `initPlatform`; that rule is stated in the
`nodeHost` module header (`src/platform/defaults/nodeHost.ts:1-14`).

### Feature-parity step — `initNodeAgentRuntime(lifecycle)`

`src/platform/defaults/nodeHost.ts:133-136`. It is exactly two registrations:

```ts
registerAgentFeatures(); // src/agent/features.ts:35-38
registerDirectLeanLanguageServices(lifecycle);
```

`registerAgentFeatures` installs the two conditional tool injections — `memory`
and the unified `plan` tool that drives the goal loop
(`src/agent/features.ts:18-31`). The shipped hosts call it after Step 1, as the
source comment prescribes (`src/agent/features.ts:33-34`). Registration itself
only stores predicates, however: the `platform().globalState` read occurs
later, when the memory predicate is evaluated. Thus this ordering is a
supported convention rather than an immediate execution dependency; the
platform must merely exist before injected tools are resolved.

If used, call it **exactly once per process**: the doc comment at
`src/platform/defaults/nodeHost.ts:129-131` records that both inner
registrations throw or double-register on a second call.

An embedder that only wants the raw loop can skip this step. An embedder that
wants the `memory` and `plan` injections but not Lean can call
`registerAgentFeatures()` directly.

### Step 2 — credential resolution

There is no model-access bootstrap call. Production model-client constructors
call `ModelHandler.resolveClientCredential` directly
(`src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts:396`;
`src/agent/modelHandlers/openai/modelHandlerOpenAI.ts:249`;
`src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts:546`;
`src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts:1165`;
`src/agent/modelHandlers/openrouter/modelHandlerOpenRouterNative.ts:142`).

Credential resolution uses the caller's own provider API keys or subscription
credentials only; there is no server-side model access to configure. A
stateless BYOK embedder needs no auth setup at all — a host that wants
persisted state (settings, credentials) must complete Step 1 before the first
model call.

### Step 3 — agent directories

To use the packaged bundle, install its matching port in Step 1 and then
bootstrap the files:

```ts
// Before Step 1:
const agentDirectories = createPlatformAgentDirectories({
  channel: 'my-embedder',
  customDirectoryStore: { get: () => undefined },
});
initPlatform(
  createNodePlatform({
    /* …8 other required services… */
    agentDirectories,
  }),
);

// src/platform/defaults/nodeHost.ts:178-199
await bootstrapNodeAgentDirectories({
  channel: 'my-embedder',
  resourcesPath, // dir containing agents/, tool_use_agents/, goal/
  currentVersion,
  versionStateKey, // your own globalState key
});
```

Alternatively, skip the bundle entirely and hand `createNodePlatform` an
`AgentDirectoriesPort` that points at your own directory. See
[§2](#2-agentdirectoriesport-is-three-directory-paths-not-agent-values) — this
is the part the plan of record describes incorrectly.

### Prerequisite A — a default or explicit session

Not part of the process bootstrap, and not in
`packages/cli/src/runtime/initPlatform.ts` at all, but a session is still
required.

`runAgent` falls back to `defaultSession()` when the caller passes no session
(`src/agent/runtime/runAgent.ts:93`), and `defaultSession()` throws
`'The default session has not been initialized. Call initializeDefaultSession() after opening its transcript store.'`
(`src/agent/runtime/SessionHandle.ts:480-485`).

Two ways out:

- `initializeDefaultSession({ transcripts: await StreamLogStore.open() })` —
  the process-default session (`src/agent/runtime/SessionHandle.ts:445-452`,
  called once; a second call throws). This is what the CLI
  (`packages/cli/src/runtime/transcriptSession.ts:45`) and the extension
  (`packages/extension/src/extension.ts:275`) do. `StreamLogStore.ephemeral(reason)`
  (`src/transcript/StreamLogStore.ts:246`) is the in-memory variant.
- Construct your own `SessionHandle` and pass it as `options.session`
  (`RunAgentOptions` picks `session` through to `executeAgent`,
  `src/agent/runtime/runAgent.ts:37`). Then `defaultSession()` is never
  consulted.

### Prerequisite B — `await loadAgents(...)`

The registry is **not** lazily populated on the run path.
`getAgentPath` → `resolveAgentForLaunch` is a synchronous read of already-loaded
state (`src/agent/index/agentRegistry.ts`); when it misses,
`AgentLaunchContext` emits `showAgentConfigBanner` and throws
`Could not find agent: <name>` (`src/agent/runtime/AgentLaunchContext.ts:158-159`).

`loadAgents` (`src/agent/index/agentRegistry.ts:116-148`) is what fills it.
Neither `runAgent`, `executeAgent`, nor `AgentLaunchContext` populates the
registry, so the caller must ensure that loading has happened before launch.
Pass `{ includeRemote: false }` unless you want the Supabase remote-agent
catalog.

### Per-session — attach host interactions when presentation is required

`runAgent` and `executeAgent` obtain presentation and approval behavior from
the selected session's stable `SessionHostInteractions` object. A host attaches
its adapter with `session.useHostInteractions(...)` and detaches that adapter
when the host presentation lifetime ends. An embedder that is certain no
response-bearing interaction can occur may leave the session unattached.
Otherwise, a non-interactive embedder must attach an explicit rejection policy;
the minimal `{ cancel: () => {} }` adapter in the example below causes
unsupported requests to receive their typed cancellation result instead of
remaining parked.

### Putting it together

This example assumes an alias-aware build from a TeXRA checkout, as described
at the start of this document. Copying these imports into an ordinary external
TypeScript project and running plain `tsc` is insufficient: there are no
runtime packages named `@platform/platform`, `@agent/runtime/runAgent`, and so
on.

```ts
import { initPlatform } from '@platform/platform';
import {
  createNodePlatform,
  initNodeAgentRuntime,
  bootstrapNodeAgentDirectories,
} from '@platform/defaults/nodeHost';
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { loadAgents } from '@agent/index/agentRegistry';
import { initializeDefaultSession } from '@agent/runtime/SessionHandle';
import { StreamLogStore } from '@transcript';
import { runAgent } from '@agent/runtime/runAgent';
import { validateExecutionRequest } from '@agent/core/state/executionRequests';
import { AgentCategory } from '@shared/schemas/agent';

const agentDirectories = createPlatformAgentDirectories({
  channel: 'my-embedder',
  customDirectoryStore: { get: () => undefined },
});
initPlatform(
  createNodePlatform({
    /* …8 other required services… */
    agentDirectories,
  }),
); // Step 1
initNodeAgentRuntime(lifecycle); // Optional shipped-feature parity
await bootstrapNodeAgentDirectories({/* … */}); // Step 3

// Use StreamLogStore.ephemeral('embedder') here for memory-only transcripts.
const session = initializeDefaultSession({
  transcripts: await StreamLogStore.open(),
});
const detachHostInteractions = session.useHostInteractions({
  cancel: () => {},
}); // see §3 — DO NOT SKIP
await loadAgents({ includeRemote: false });

const validated = validateExecutionRequest({
  config: {
    agent: 'assistant',
    agentCategory: AgentCategory.ToolUse,
    instruction: 'Hello',
  },
});
if (!validated.valid) throw new Error(validated.message);

try {
  await runAgent(validated.request, { session });
} finally {
  detachHostInteractions();
}
```

`validateExecutionRequest` (`src/agent/core/state/executionRequests.ts:24-45`)
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
tool-use agent directory (`src/agent/index/agentYamlScanner.ts:212-217`);
launch resolution searches only the requested category
(`src/agent/index/agentRegistry.ts:740-749`).

---

## 2. `AgentDirectoriesPort` is three directory paths, not agent values

`docs/proposals/2026-07-09-agent-sdk-north-star.md:79-85` and
`docs/proposals/2026-07-09-state-of-the-architecture.md:815-824` present
"inject `AgentDirectoriesPort`" as the answer to "load agent X from a YAML" for
an embedder. That is correct only in a narrow sense, and the phrasing invites a
wrong reading. State it plainly:

```ts
// src/platform/interfaces.ts:270-274
export interface AgentDirectoriesPort {
  custom(): Promise<string>;
  builtIn(): Promise<string>;
  builtInToolUse(): Promise<string>;
}
```

Three methods, each returning a **directory path string**. The port cannot
carry an agent definition, a parsed object, a YAML string, or a virtual
filesystem. Injecting it redirects the scan to _a different real directory on
disk_; that is the entire capability.

### Why in-memory definitions cannot work: two filesystem planes in one function

`loadAgents` calls `doLoad`, which resolves the three paths and hands each to
`scanDirectory` (`src/agent/index/agentRegistry.ts:150,160-173`). Inside
`scanDirectory`:

- **Enumeration** uses the npm `glob` package with **no `fs` option**
  (`src/agent/index/agentYamlScanner.ts:53-57`, import at `:3`). `glob` without
  an injected `fs` reads the real Node filesystem directly.
- **Reading** three lines later goes through the platform:
  `AbsoluteFS.read` (`src/agent/index/agentYamlScanner.ts:112`) →
  `BaseFS.read` → `platform().fs.readFile`
  (`src/utils/files/baseFS.ts:71-77`).

So one function straddles two filesystem planes. Replacing `platform().fs` with
an in-memory provider changes only the _read_ half; `glob` still enumerates the
real disk and finds nothing, so the scan yields zero agents.

### The repo's own tests prove the constraint

`src/test-kernel/agent/AgentRegistry.vitest.ts` is a memfs-backed test
kernel (`createFakePlatform` defaults to `new FakeFileSystemProvider(...)`,
`src/test-kernel/support/FakePlatform.ts:503`, backed by `memfs` at `:5`). To
test the agent registry it has to opt _out_ of memfs:

```ts
// src/test-kernel/agent/AgentRegistry.vitest.ts
createFakePlatform(
  { workspaceState },
  { fs: nodeFilesystem, agentDirectories: mutableAgentDirectories },
);
```

…and to register a single custom agent it must create a real temp directory and
write a real YAML file:

```ts
// src/test-kernel/agent/AgentRegistry.vitest.ts
const customDir = await mkdtemp(resolve(tmpdir(), 'texra-custom-agent-'));
await writeFile(resolve(customDir, 'chat.yaml'), [...].join('\n'));
…
useAgentDirectories({ custom: async () => customDir });
```

Its `builtIn()`/`builtInToolUse()` point at the real repo tree
(`packages/extension/resources/agents`, `…/tool_use_agents`) —
`src/test-kernel/agent/AgentRegistry.vitest.ts`.

If the codebase's own memfs kernel cannot avoid touching real disk to register
one agent, an embedder cannot either.

### What injection _does_ buy you

- **Skipping the packaged bundle.** `scanDirectory` returns `[]` for an empty
  path (`src/agent/index/agentYamlScanner.ts:49`), so
  `builtIn: async () => ''` and `builtInToolUse: async () => ''` are legal and
  cheap. This is the "empty-builtIn trick" the proposals mention, and it does
  work. With it you can skip Step 3's `bootstrapNodeAgentDirectories` entirely
  and point `custom()` at your own directory of YAML.
- **Choosing where custom agents live.** The CLI builds its port with
  `createPlatformAgentDirectories({ channel: 'cli', customDirectoryStore: … })`
  (`packages/cli/src/runtime/initPlatform.ts:276-279`,
  `src/agent/index/platformAgentDirectories.ts:25-57`). An embedder is free to
  supply a three-line literal instead:

  ```ts
  const agentDirectories: AgentDirectoriesPort = {
    custom: async () => '/abs/path/to/my/agents',
    builtIn: async () => '',
    builtInToolUse: async () => '',
  };
  ```

  Note that the built-in tree is where the shipped agents live; emptying it
  means _only_ your YAML is resolvable. Whether any runtime feature hard-requires
  a specific built-in agent name is an open question — the state-of-the-architecture
  note flags it as a residual unknown
  (`docs/proposals/2026-07-09-state-of-the-architecture.md:825-826`) and this
  document does not resolve it.

**Bottom line for an SDK conversation:** the port is a _directory redirect_,
not a definitions API. "Definitions as values" would be new code, not
documentation.

---

## 3. The headless minimum for interactions — the one section to read

**`session.useHostInteractions({ cancel: () => {} })` is safe. Attaching
nothing is not.** This is the inverse of what the mostly-optional method
signatures suggest, and it is the single highest-consequence fact in this
document.

### The mechanism

Every blocking interaction goes through `SessionHostInteractions.enqueue`
(`src/agent/runtime/HostInteractions.ts:595-618`), which adds the pending
record to `this.pending` and then calls `dispatch`:

```ts
// src/agent/runtime/HostInteractions.ts:615-617
this.pending.add(pending);
if (this.pending.size === 1) this.notifyPendingCountChange();
this.dispatch(pending);
```

`dispatch` starts with:

```ts
// src/agent/runtime/HostInteractions.ts:667-669
private dispatch(pending: PendingSessionInteraction): void {
  const attachment = this.activeAttachment;
  if (!attachment) return;
```

The pending promise has already been created and registered. With no
attachment, `dispatch` returns **without settling it and without scheduling
anything that will**. The agent awaits that promise forever.

With an attachment whose method is simply _omitted_, the optional-call yields
`undefined` and the very next branch settles it:

```ts
// src/agent/runtime/HostInteractions.ts:678-681
if (!result) {
  this.deletePending(pending);
  pending.settle(pending.cancellationResult());
  return;
}
```

Each request wrapper supplies its own `cancellationResult` factory
(`src/agent/runtime/HostInteractions.ts:450-521`; the factory table is at
`:217-235`), so the run receives a well-typed "declined/cancelled" answer and
continues.

Nothing in the runtime attaches interactions for you. A fresh `SessionHandle`
constructs an empty `SessionHostInteractions`
(`src/agent/runtime/SessionHandle.ts:167`), and the only production caller of
`.use(...)` is `SessionHandle.useHostInteractions`
(`src/agent/runtime/SessionHandle.ts:181-183`).

### The affected calls

Six request kinds park when unattached — `requestToolEditApproval`,
`requestBashApproval`, `requestPlanApproval`, `requestAgentProposal`,
`requestRetry`, `askUserQuestion`
(`src/agent/runtime/HostInteractions.ts:450-521`).

`openExternalInquiry` is deliberately excluded: it reads
`this.activeAttachment?.interactions.openExternalInquiry?.(request)` directly
(`src/agent/runtime/HostInteractions.ts:523-530`), and its comment at `:526-529`
explicitly says this is to avoid "parking the agent while no UI is attached" —
the runtime already knows the parking behaviour exists.

### Escape hatches, and why they are not a substitute

- **Attaching later unblocks.** `use()` calls `activateCurrentAttachment`,
  which redispatches everything still pending
  (`src/agent/runtime/HostInteractions.ts:621-639`). Parking is not permanent
  _if_ a host eventually attaches.
- **Interrupting a retained run handle settles pending interactions.**
  `RunAgentOptions.onRun` exposes an `AgentRunHandle`
  (`src/agent/runtime/runAgent.ts:29-42`;
  `src/agent/runtime/ExecutionHandle.ts:328-342`). Retain it and call
  `handle.interrupt()` to abort the run; both workflow and tool-use
  interruption call `runSession.interactions.cancel`
  (`src/agent/runtime/executeAgent.ts:215-221`;
  `src/agent/implementations/flows/tooluse/runToolUseFlow.ts:347-349`).
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
  `src/agent/implementations/flows/tooluse/runToolUseFlow.ts:199`). It does not
  touch `requestRetry` or `askUserQuestion`, and it does not change dispatch.
  The CLI sets it for `policy === 'never'` and for headless `ask`
  (`packages/cli/src/runtime/approval/settleApprovals.ts` —
  `cliApprovalPromptsUnavailable`) _in addition
  to_ attaching real interactions.

### The typed shape

`cancel` is the one **required** member of `HostInteractions`
(`src/agent/runtime/HostInteractions.ts:336`); every other member — the seven
request methods plus `emit`, `dispose`, `showInfoMessage`, the diagnostics
readers, and `setApprovalBypassState` — is optional
(`src/agent/runtime/HostInteractions.ts:293-338`). So the compiler already
forces you to write `{ cancel: … }` — the trap is not a badly-typed object, it
is **never calling `useHostInteractions` at all**, which no type can catch.

### The headless embedder contract (issue #9256)

Issue #9256 asked what a session should do when no interaction host is ever
attached at all. The ruling: **no runtime semantic change.** Parking (above)
stays — it is what lets a desktop per-window reattach pick up a request that
parked before it attached — and the runtime installs no default attachment.
Instead, the ruling names the mechanism above as the contract: attach at
least `{ cancel: () => {} }`, and use `approvalPromptsUnavailable: true` to
remove the most common case that is reachable without any attachment at all
(a headless run without `approvalPromptsUnavailable` can also reach
`requestRetry` without an attachment; both gaps are closed by the flag).

**`approvalPromptsUnavailable: true` is the real headless answer for that
case**, not merely a partial mitigation: an agent that cannot be asked simply
is not given the tools that require asking, which is a defined, loud
degradation instead of a hang. Trace the wiring end to end:

- `executeAgent` threads `options.approvalPromptsUnavailable` into the run
  context on both a fresh launch and a resume
  (`src/agent/runtime/executeAgent.ts:392-396`, `:547-550`).
- The tool-use flow reads it back off the run context and forwards it to tool
  resolution (`src/agent/implementations/flows/tooluse/runToolUseFlow.ts:199`).
- `resolveAgentTools`'s shared gate drops any tool with
  `requiresApproval: true` once the flag is set, before the model ever sees it
  in its tool list (`src/agent/runtime/agentToolResolution.ts:150-157`).

The worked example is the CLI's own headless path: it derives the flag from
policy and mode (`packages/cli/src/runtime/approval/settleApprovals.ts` —
`cliApprovalPromptsUnavailable`)
and passes it straight into the real `runAgent` call
(`packages/cli/src/runtime/runExecution.ts`). As the "Escape hatches"
note above says, the flag does not touch `requestRetry` or `askUserQuestion`
dispatch — it only narrows which tools can raise the approval kinds that were
the reachable hang.

**The diagnostic for getting it wrong anyway:** #9225 made an unattached
`dispatch` log a warning before returning, naming the parked request kind and
stream and prescribing the `{ cancel: () => {} }` minimum
(`src/agent/runtime/HostInteractions.ts:654-659` calls `warnParked`, defined
at `:685-696`).

**Why there is no runtime default.** `activeAttachment` is the most recently
attached host (`this.attachments.at(-1)`,
`src/agent/runtime/HostInteractions.ts:573-575`); detaching reactivates
whatever is left, or re-parks anything still pending if nothing is
(`:381-389`, `:603-626`). A permanent default-denier occupying that stack
would instead settle every live approval the instant the real host detached —
and desktop attaches and detaches per window, one `DesktopProgressBridge`
per `BrowserWindow` calling `useHostInteractions` on the one process-owned
session and disposing it on close
(`packages/desktop/src/main/desktopAgentExecution.ts:420-429`;
`packages/desktop/src/main/index.ts:583-621`). Closing one window would
silently deny a pending tool-edit diff. A latch that auto-denies before any
host has ever attached fares no better: the runtime cannot know whether a
UI is coming; the caller can, and `approvalPromptsUnavailable` is how it
says so.

---

## 4. What degrades gracefully (safe to skip)

- **`initializeBundledPrompts(resourcesPath)`:** Registers the packaged
  `resources/` root for every row of the bundled-prompt table
  (`src/agent/runtime/bundledPrompts.ts`). Degradation is per row, not global:
  the `goal` row falls back to its inline copy when no root was registered, and
  also on a broken YAML — logging a warning in that case; the `polish` row is
  `required` and rejects instead, so an embedder that skips this call loses
  follow-up polish loudly. Skipping it is safe only if the embedder renders no
  polish prompt.
- **`initializeNodeRuntimeSkills({…})`:** Runtime skills degrade to an empty
  catalog: `if (sources.length === 0) return { catalog: '', issues: [] };`
  (`src/skills/runtimeSkills.ts:57-59`; registration at
  `src/platform/defaults/nodeHost.ts:157-169`).
- **`seedDisabledToolDefaults(key)`:** No first-install tool defaults are
  written, so no toggleable external tools are default-disabled. More tools
  are available, not fewer (`src/tools/toolAvailability.ts:77-95`).
- **`initNodeAgentRuntime(lifecycle)`:** The raw loop still runs, but the
  `memory`/`plan` injections and direct Lean language services are absent
  (`src/platform/defaults/nodeHost.ts:121-136`;
  `src/agent/features.ts:18-38`).
- **`registerDirectLeanLanguageServices`:** If the embedder calls
  `registerAgentFeatures()` alone instead of `initNodeAgentRuntime`, Lean LSP
  tooling is unavailable; the `memory`/`plan` injections remain registered
  (`src/platform/defaults/nodeHost.ts:133-136`).

`bootstrapNodeAgentDirectories` is safe to skip **only** if the installed
`AgentDirectoriesPort` names directories populated by some other means (§2).
When using `createPlatformAgentDirectories`, skipping the bootstrap leaves its
global-storage built-in directories unpopulated, and `loadAgents` finds no
packaged agents.

---

## 5. Reading the CLI: obligations vs. product features

`packages/cli/src/runtime/initPlatform.ts` is 392 lines and performs ~15
registrations after `initPlatform`. An embedder reading it cannot tell which
are runtime requirements and which are `texra`-the-product. The following
classification makes that distinction.

### Runtime bootstrap and shipped-feature parity

- **`:280` — `initPlatform(createNodePlatform({…}))`:** Required.
  `platform()` throws otherwise (`src/platform/platform.ts:73-80`).
- **`:316` — `initNodeAgentRuntime(lifecycle)`:** Shipped-feature parity, not a
  raw-loop requirement. It registers the `memory` and `plan` injections and
  direct Lean services. Without it those features are absent
  (`src/platform/defaults/nodeHost.ts:121-136`;
  `src/agent/features.ts:18-38`).
- **`:380` — `bootstrapNodeAgentDirectories({ channel: 'cli', … })`:**
  Required only when using the packaged agent bundle; an injected port that
  names other real directories replaces it (§2).

### CLI initialization choices (8) — not runtime obligations

- **`:306` — `seedDisabledToolDefaults(...)`:** First-install policy:
  default-disable toggleable external tools. The key is versioned per host.
- **`:311` — `installCliShutdownSignalHandlers(lifecycle)`:** SIGINT/SIGTERM
  handling for a terminal process.
- **`:320` — `applyCliGitAuthorConfig(platform().config)`:** Attributes
  agent-authored commits to the TeXRA Git identity.
- **`:327-330` — `UsageLogService.initialize(...)` and shutdown flush:**
  Supabase usage logging tagged `editorType: 'cli'`, for telemetry.
- **`:334` — `initializeCliSupabaseAuth(log, storageRoot)`:** Supabase sign-in
  wiring for the CLI's authentication flow.
- **`:342-348` — `setSetupPlatform({ host: 'cli', signIn })`:** Wires the
  setup-assistant onboarding surface.
- **`:350-357` — OpenRouter reconciliation and model-cache invalidation:**
  Resolves the persisted OpenRouter toggle.
- **`:359-377` — authentication probe and CLI model policy:** Installs the
  account probes (Codex/xAI eligibility) and applies the CLI's
  `--helper-model` flag.

### Optional, graceful (2)

- `:378` — `initializeBundledPrompts(context.resourcesPath)` (§4).
- `:387` — `initializeNodeRuntimeSkills({…})` (§4).

### Cross-check against desktop

The desktop main process makes the same three initialization choices, showing
how a shipped host obtains full feature parity rather than proving that every
call is a minimum runtime requirement:
`initPlatform` at `packages/desktop/src/main/platform/index.ts:272`,
`initNodeAgentRuntime` at `:317`, and `bootstrapNodeAgentDirectories` at
`:324`. It also calls the two optional ones (`:318`, `:319`). Product policy is
not necessarily CLI-only:
desktop also calls
`seedDisabledToolDefaults(GlobalStateKey.LAST_KNOWN_VERSION)` at
`packages/desktop/src/main/platform/index.ts:304-307`.

---

## 6. Known sharp edges

1. **Only part of the shipped ordering is immediately load-bearing.** Step 3
   reads `platform()`, so Step 1 must precede it; nothing checks this beyond the
   throw in `platform()` itself. Feature-parity registration stores
   predicates and a Lean adapter without evaluating host services; the
   platform is needed only when the memory predicate later runs
   (`src/agent/features.ts:18-38`;
   `src/tools/lean/direct/directLspAdapter.ts:47-52`).
2. **Feature-parity registration is once-per-process.** A second
   `initNodeAgentRuntime` throws or double-registers
   (`src/platform/defaults/nodeHost.ts:129-131`). Contrast
   `initializeBundledPrompts`, which is explicitly re-entrant
   (`src/agent/runtime/bundledPrompts.ts`: a later call replaces the resources
   root and drops the cache) because CLI validation re-enters platform init in
   one process.
3. **`bootstrapNodeAgentDirectories` uses an ambiguous string guard key.** A
   module-level `Map` stores `resourcesPath` under the guard key
   `${channel}:${versionStateKey}`
   (`src/platform/defaults/nodeHost.ts:84,181-185,198`). A call is skipped when
   that derived string and the resources path match a previous call. Colons are
   not escaped, so distinct pairs such as `('a:b', 'c')` and `('a', 'b:c')`
   collide. Embedders must use colon-free channel and version-state values
   until the key representation is made unambiguous.
4. **The registry is process-global**, not session-scoped
   (`src/agent/index/agentRegistry.ts:116-148`). There is no per-embedder agent
   namespace.
5. **`initializeDefaultSession` throws on a second call**
   (`src/agent/runtime/SessionHandle.ts:445-449`). Embedding inside a process that
   already hosts TeXRA means reusing `tryDefaultSession()` or owning your own
   `SessionHandle`.
6. **Some failure modes cluster at run time, not startup.** A missing
   `loadAgents` throws at agent resolution, and a missing interactions
   attachment hangs mid-run. Neither fails fast at bootstrap.

## 7. Related documents

- `docs/proposals/2026-07-09-agent-sdk-north-star.md` — NS-4 (`:79-85`,
  `:164`) is the item this document discharges. Its acceptance table
  (`:166-176`, rows at `:170-171`) counts "Ordered post-init registrations to first run: 9-10,
  untyped" and "Deep imports for a minimal embedder: ~20 modules"; §1 and §5
  above are the concrete baseline those metrics need.
- `docs/proposals/2026-07-09-state-of-the-architecture.md:815-826` — the NS-4
  finding, including the empty-`builtIn()` trick and the residual unknown about
  hard-required built-in agent names.
- `docs/architecture/agent-trace.md` — the run-scoped event channel an embedder
  reads for progress.
