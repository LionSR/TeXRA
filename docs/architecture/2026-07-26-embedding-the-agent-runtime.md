# Embedding the TeXRA Agent Runtime

**Status: internal. Not published on texra.ai.** A program outside this
repository embeds the harness through the published package
`@texra-ai/harness` and its entries (`.`, `/builtins`, `/node`, `/plugins`,
`/schemas`, `/transcript`), documented in `packages/harness/README.md`. §1 and
§2 use only those entries. §3 onward also names the internal composition
behind them (`processLayer` on `/host`, and modules reached through the
repo-root path aliases in `tsconfig.json`), for work on the harness itself.
Plain `tsc` output does not rewrite those aliases, so no internal module name
below is reachable from an installed package, and none is a stable contract.

The runnable versions of everything in §1 and §2 are the packed-tarball
examples in `packages/harness/example/` (`02-session-and-events.ts` is the
closest to the sample below), which CI installs from the packed tarballs and
runs.

---

## 1. What an embedder supplies

There are no agent files, no agent directory and no agent catalog. A run
carries what it is: its system text, the tools it declares and a display
label, recorded on its `run.config` row, so neither a start nor
a resume reads anything from disk to find out what the run is. An embedder
supplies four things, all to `Sessions.layer({ platform, plugins, client,
skills })` (`packages/harness/src/effect/processLayer.ts`; the shape is
`Composition` in `packages/harness/src/effect/sessions.ts`):

- **`platform`**, an `AgentPlatform`: the `WorkspaceRoots` of the folder the
  runs work in (its storage path, config, project state and the
  process-wide global state), the secret store provider keys are read from,
  and optionally a `resourcesRoot` (the files the host ships beside its code,
  served to plugins as `HostResources`). `nodePlatform({ storageDir,
  workspaceDir, settings })` from `@texra-ai/harness/node` builds one:
  process-local config and state, the storage layout under `storageDir`
  (required; nothing falls back to a per-user directory), and secrets read
  from the environment (`ANTHROPIC_API_KEY`, …).
- **`plugins`**: what the runs can use. `harnessBuiltins` from
  `@texra-ai/harness/builtins` is the harness's own six (`codemode`,
  `fileOps`, `goal`, `memoryWorkflow`, `multiAgent`, `web`); an embedder
  lists its own plugins (`definePlugin` from `@texra-ai/harness/plugins`)
  beside them. A tool a run names that no listed plugin offers fails the run
  before any model call. A list the harness cannot compose (an id listed
  twice, a malformed id, a `requires` naming a plugin not listed, …) fails
  the layer's build with `PluginsRefused`.
- **`client`**: the app the process signs in and sends model requests as
  (`{ name, id }`). The harness names no client of its own.
- **`skills`** (optional): where skills are discovered. Absent, the process
  discovers none.

Model requests go through the harness's own HTTP transport with the
environment's proxy policy. To answer them yourself (a scripted model in a
test), merge `ModelFetch` beneath `Sessions.layer` with
`Layer.provideMerge`, as `packages/harness/example/_support.ts` does.

`Sessions.layer` is an ordinary Effect layer: build it once per process. Its
release closes every session it opened, then the process under them.

## 2. What a start looks like

`session.start(input)` takes the start as data (`StartRequestSchema` in
`packages/harness/src/shared/session/runtimeRequest.ts`, exported from
`@texra-ai/harness/schemas`), in one of two forms:

- `{ system, tools?, label?, instruction, model }`: the run's
  own system text (before what the harness appends: the project's
  `AGENTS.md`, attached memories, tool-use instructions, the plugins'
  sections), the tool names it declares (`mcp__<server>__*` for every tool of
  a configured MCP server; none, and it answers in text only), the name its
  card and run directory show (default `agent`), the instruction, and the
  model as `provider/id`. The harness names no default model, and a run
  names no temperature: its model samples at its own.
- `{ config }`: a whole `AgentConfig`
  (`packages/harness/src/shared/schemas/agentConfig.ts`), for a host that
  builds the configuration itself.

Both take the start options beside them (`runId`, `continues`,
`helperModel`, `approval`, `interactive`, `apiKeys`; `StartOptionsSchema`
says when each belongs there rather than on the config). Tools for this run
alone, made with `defineTool`, go in `runTools`; a resume of the run passes
them again (`session.resume(runId, { runTools })`).

This sample matches `packages/harness/example/02-session-and-events.ts`,
minus its scripted model:

```ts
import { Effect, Stream } from 'effect';
import { responseText, Sessions } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/builtins';
import { nodePlatform } from '@texra-ai/harness/node';

// Process-wide: build it once.
const platform = nodePlatform({
  storageDir: './.agent-storage',
  workspaceDir: process.cwd(),
});

const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots);
  // With no approval handler attached, the session offers no tool that
  // requires approval and denies every request a run opens (§3).
  const run = yield* session.start({
    label: 'abstract_editor',
    system: 'You review LaTeX abstracts for concision.',
    tools: ['read_file'],
    instruction: 'Check the abstract length.',
    model: 'anthropic/claude-sonnet-5-5',
  });
  // The events end when the run does; `responseText` keeps the answer's
  // text and drops the model's thinking and tool output.
  yield* Stream.runForEach(run.events.pipe(responseText), (text) =>
    Effect.sync(() => process.stdout.write(text)),
  );
  return yield* run.result;
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: harnessBuiltins,
      client: { name: 'My App', id: 'my-app' },
    }),
  ),
);

const end = await Effect.runPromise(program);
console.log(end.outcome, end.output.response);
```

`session.start` checks its input before any model work (`acceptInput` in
`packages/harness/src/effect/sessionPrograms.ts`). It fails with
`ToolsRefused` when `runTools` holds a tool that requires approval on a
session no host can answer, and with `LaunchRefused` for an input
`AgentConfigSchema` rejects (more output files than inputs), an unknown model (the error carries the `notice` a host shows for
it) or a `runId` already in the session. A launch that fails for any other
reason before the run exists fails with `RunFailure`. Once `start` returns a
`Run`, a failure is the run's own: the handle's `result` succeeds with the
stored end, `outcome: 'failed'` and its classified `error`.

A run reaches other runs in three ways, all through its tools:

- **Helper agents** (`agent`, from the `multiAgent` built-in): the model
  writes the child's `system`, `tools` and `label` in the call, or names an
  agent an installed Claude Code or Codex plugin provides (`agentName:
  '<plugin>:<name>'`), which is read once, at the call, into the child's
  config (`packages/harness/src/agent/runtime/delegation/pluginAgents.ts`).
- **Programs** (`Plugin.programs`): a plugin's script module started by name,
  from the `program` tool or `program(name, args)` inside a `script`. Its run
  is the module's default export called with the arguments, instruction and
  files; it asks no model itself. `@texra-ai/harness` ships no program;
  example `10-external-plugin.ts` registers one and starts it from a script.
  An application host that starts a program as a root run builds its config
  with `programLaunch` (on `/host`) and starts it as `{ config }`.
- **Itself** (`self()` inside a script): a child that runs as its caller.

## 3. Requests and headless sessions

**Every request a run opens waits until something decides it.** A run that
needs a person (a command to approve, an edit, a plan, a delegation, a
question, a retry after a provider failure) commits a `request.opened` row
and waits for the `request.decided` row that answers it. The kinds are a
closed set the harness declares (`RequestPayloadSchema`,
`packages/harness/src/shared/schemas/request.ts`); a plugin opens none of its
own.

An embedder decides them in one of three ways:

- **Attach an approval handler.** `session.attach({ approve })` attaches a
  host for the caller's scope (one host at a time). `approve` is called once
  for each request a run waits on and returns the `RequestDecision` to
  record. A handler that fails, throws or answers with a decision the
  request's kind does not take is a denial, logged.
- **Answer from the view.** Open the session with
  `{ answeredFromView: true }` when a person reads `SessionView.requests` and
  answers with `session.request({ kind: 'request.decide', runId, requestId,
  decision })`. Whichever answer lands first is the decision.
- **Do neither.** Then nobody can answer, and the session's approval
  policy decides every request as it opens: under `ask` (the default) or
  `never` it denies them, retries included, and no run is offered a tool
  that requires approval.

The withholding is decided per step, not per start: each step applies the
session's approval policy to whether the attached host can answer
(`liveToolGates` in `packages/harness/src/agent/runtime/requests.ts`), and
`resolveStepTools` (`packages/harness/src/agent/runtime/agentToolResolution.ts`)
drops every tool that asks approval (`requiresApproval`, or a `guard.command`:
`asksApproval`) before the model sees it. So a host attached mid-run, or a
policy change, reaches the next step's offer, and a delegated child, which
runs on its parent's session, gets the same answer. A run's own `runTools`
are not withheld at a step: one that asks approval is refused at the start
instead (`ToolsRefused`, above). Under the `yolo` policy the gated tools are
offered even to a session nobody answers, and the policy approves them.

A request a stopped run leaves open is cancelled with the run's end, in the
same batch; one a crashed process left open is cancelled at the run's next
activation, and the call that opened it asks again on resume. Stopping a run
(`session.request({ kind: 'run.stop', runId, reason })`) is the cancellation
path, not a substitute for answering a run that should continue.

Inside the repository, a host's presentation adapter is a `HostInteractions`
(`packages/harness/src/agent/runtime/HostInteractions.ts`): events,
notices, PDFs, the edit preview a durable payload cannot carry. No method on
it returns a decision; its `approvalPromptsUnavailable` field is how an
internal host that attaches no handler says whether its surface can prompt.
The headless CLI answers from its mode and a terminal prompt
(`createHeadlessCliHostInteractions`,
`packages/cli/src/runtime/headless/approvalAdapter.ts`).

## 4. The composition behind `Sessions.layer`

`Sessions.layer` is `processLayer`'s composition for an embedder.
`processLayer(options)` (`packages/harness/src/effect/processLayer.ts`,
exported from `/host`) is what TeXRA's hosts build their runtime over. Its
options (`ProcessLayerOptions`, over `ProcessServicesOptions` in
`packages/harness/src/controllers/session/sessionLayer.ts`):

- `storageRoot` and `settings` (the settings catalog the state stores key
  rows under);
- `plugins`, validated once by `toolTable` (`PluginsRefused` on a defect);
- `secrets`, the credential store and the subscription accounts over it
  (`Secrets.layer`, or `Secrets.announcing` for a store that announces its
  writes);
- `hostResources`, a `HostResources` layer naming the resources root, if
  any;
- `appState`, the global store; absent, the one under the storage root,
  seeded with the first-install tool switches (`seedDisabledToolDefaults` in
  `packages/harness/src/tools/toolAvailability.ts`). A store handed in is
  left as it is;
- `skills`, the skill sources, served beneath every session as
  `HostSkillSources`;
- `usageLog` and `minimumLogLevel`, absent for an embedder: no usage is
  reported, and the embedder's own logger, level and tracer decide where the
  harness's lines go;
- `workspace`, a single-project host's folder, whose `.env` its reads see.

It requires the Node filesystem, path and child-process spawner
(`nodePlatformServices` from `/node`). Two things `processLayer` adds that
`Sessions.layer` does not: it installs the model transport's dispatcher as
the process's global HTTP dispatcher, and it titles every root run with one
extra helper-model request (`LabelsRootRuns`,
`packages/harness/src/agent/runtime/sessionDescription.ts`), counted in the
run's usage.

Per-workspace services are a `WorkspaceRoots` (`@platform/workspaceRoots`)
carried by each session, so one process can hold sessions over several
folders. A host opens one with `openNodeWorkspaceRoots` (from `/node`;
`packages/harness/src/platform/defaults/nodeHost.ts`), which resolves the
storage path, picks the config provider and opens the project's state store
in the caller's scope. `Sessions.open(roots, options)` opens the session of
`roots`, or returns the one already open over that storage root;
`options.persistent` keeps its history in the root's SQLite store. Only a
composition root calls `processLayer`: `packages/texra/src/controllers/texraProcessLayer.ts`,
`Sessions.layer` and the test kernel's `src/test-kernel/support/testKernel.ts`.

### How TeXRA's hosts compose it

The CLI (`packages/cli/src/runtime/platform/cliProcessRuntime.ts`), the
desktop main process (`packages/desktop/src/main/platform/index.ts`) and the
extension (`packages/extension/src/extension.ts`) all build one
`ManagedRuntime` over `texraProcessLayer`, which fixes TeXRA's choices around
`processLayer`: its settings catalog, `texraPlugins(...)` (the six built-ins
with TeXRA's write filter, plus TeXRA's own), skill sources over the bundled
resources and `.texra/`, one `FileSecrets` store under the storage root, the
resources root as `HostResources`, the usage log, and the window table the
editor tools read (`HostWindows`). A host checks its resources path first
(`checkResourcesPath`, which refuses one with no bundled `plugins/`
directory).

The Lean tools are one of those plugins, not a runtime requirement:
`lean4` (`packages/texra/src/tools/lean/plugin.ts`) brings the `lake env lean
--server` pool as its process layer (`directLeanLanguageServices`,
`packages/texra/src/tools/lean/direct/leanServerPool.ts`), which spawns
nothing until a Lean tool runs and stops with the runtime. A composition
without it offers no Lean tools.

The CLI shows the shutdown order a long-lived embedder should keep
(`openCliPlatform` in `packages/cli/src/runtime/platform/initPlatform.ts`):
it opens the workspace roots and, lazily and once, the session in one scope
of its own; leaving closes that scope first (the session stops and finishes
its runs, killing agent-spawned processes with them, and flushes its
artifacts; then the project's state store closes) and disposes the runtime
after. `holdSignals` (`packages/cli/src/runtime/platform/processSignals.ts`)
is the one place it listens for a signal.

## 5. What degrades gracefully

- **No `skills`:** discovery finds nothing (`packages/harness/src/skills/runtimeSkills.ts`).
  Given sources, the bundled tier reads the resources tree's `skills/` and
  each listed plugin's `plugins/<id>/skills`, a missing directory reading as
  none (`packages/harness/src/skills/skillSources.ts`).
- **No `resourcesRoot`:** a plugin that reads `HostResources` gets none; the
  harness's built-ins read nothing from it.
- **An `appState` handed to `processLayer`:** no first-install switches are
  written, so a plugin whose switch starts off is on. More tools, not fewer.
- **Lean without `lake`:** the `lean4` probe reports the plugin as needing
  setup, and a step offers none of its tools, programs or prompt section
  (the probe's result is read by `resolveStepTools`).

## 6. Known sharp edges

1. **The process runtime is once per process.** A second live build of the
   layer that opens a root the first holds is refused at open, as a second
   process is: the project store is held exclusively.
2. **One session per storage root.** `Sessions.open` returns the session
   already open over the same root, built from what its first opener
   supplied; a later open asking for a different store fails with
   `SessionOptionsConflict`.
3. **The plugin list is fixed for the process.** Switching a plugin off
   withdraws its tools, programs and prompt section at a run's next step;
   adding a plugin of the embedder's own needs a new layer. Installed
   plugins (Claude Code and Codex layouts under the storage root) are read
   afresh at each step.
4. **Failures cluster at run time, not startup.** An unknown model is a
   `LaunchRefused` at the start; a tool a run names that no plugin offers
   fails the run before its first model call; a request nobody decides
   waits until something does (§3). None of these fails at bootstrap.

## 7. Related documents

- `packages/harness/README.md`: the package's surface, approvals, resume,
  durable invariants and storage failures.
- `packages/harness/docs/spec.md`: what each commit point guarantees.
- `docs/architecture/2026-06-20-agent-trace.md`: the run-scoped event
  channel an embedder reads for progress.
