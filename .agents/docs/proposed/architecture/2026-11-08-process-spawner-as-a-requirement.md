# The process spawner as a requirement of `processLayer`

Status: proposed, 2026-11-08. Closes the rest of R5-8 (round 5 tests, L1
F1.6): the background cases of `packages/harness/test/tools/BashTool.vitest.ts`
and `packages/harness/test/tools/ExecutionsToolOutput.vitest.ts`, which still
stub `executeCommand` with `vi.spyOn` because no suite can give a session's
runs a spawner. #14844 declined a `processLayer` option for this as a
test-only knob; this note is the design without one.

## Where the spawner comes from today

A background `bash` call is a process child (`processRun`,
`packages/harness/src/agent/runtime/processRun.ts`) whose turn needs
`PlatformServices`. It runs on the fiber `RunRegistry.start` forks over the
session's context, and that context comes from the process layer:
`ownerProcessLayer` (`packages/harness/src/controllers/session/sessionLayer.ts`)
merges `nodePlatformServices` (the Node `FileSystem`, `Path` and the
supervised `ChildProcessSpawner`) into its own output with
`Layer.provideMerge`. Because the layer provides the spawner to itself, a
spawner a suite provides from outside never reaches the runs:
`processLayer`'s type, `Layer<ProcessServices | Sessions, PluginsRefused>`,
needs nothing from its caller.

The model edge is the precedent for the other shape. The test kernel
composes `processLayer(...).pipe(Layer.provide(model))`
(`src/test-kernel/support/testKernel.ts`, `composedProcess`): what answers
model calls comes from whoever builds the layer, so `SessionGraph.with`
takes a model and no option exists for it.

## The design

1. **`processLayer` requires the platform's Node services.** Its type
   becomes `Layer<ProcessServices | Sessions, PluginsRefused,
   FileSystem.FileSystem | Path.Path | ChildProcessSpawner>`, and
   `ownerProcessLayer` stops merging `nodePlatformServices` (it keeps
   `workspaceEnvironmentLayer`, the HTTP client and the diagnostics). The
   cold-read `Context.pick` in `sessionsLayer` reads the same services as
   before.
2. **Production provides it once.** `texraProcessLayer`
   (`packages/texra/src/controllers/texraProcessLayer.ts`), the one
   production caller, which the extension, desktop and CLI roots all build
   through, adds `Layer.provide(nodePlatformServices)`. The SDK's
   embedders compose the same line; `nodePlatformServices` is already on
   `@texra-ai/harness/node`. The API report and the `host` docs change with
   the type (`npm run docgen`).
3. **The test kernel provides it per block.** `composedProcess` takes the
   platform layer beside the model:
   `processLayer(...).pipe(Layer.provide(Layer.merge(model, platform)))`.
   `SessionGraph.layer` and `.hosted` pass `nodePlatformServices`;
   `SessionGraph.with(plugins, model, platform)` lets a block pass
   `Layer.provideMerge(scriptedSpawnerLayer(script).layer, nodeFsAndPath)`.
   This is the kernel's own parameter, like `model`, not a production option.
4. **The scripted spawner answers later.** `ScriptedAnswer`
   (`src/test-kernel/support/childProcessTestLayer.ts`) gains an `exitCode`
   that may be an `Effect` (a `Deferred.await`), which `holdCommand` needs: a
   command released by the case with exit 143. `stdout` already takes a
   `Stream`, which covers the two-chunk output and ExecutionsToolOutput's
   chunks-then-open process (`Stream.concat(chunks, Stream.never)`).
5. **The suites.** BashTool's background block and ExecutionsToolOutput
   build their graph with `SessionGraph.with([], validationModelLayer,
   scripted)` and assert the same tool results and `run.end` rows. The
   `vi.spyOn(execUtils, 'executeCommand')` sites and `holdCommand`'s spy go.
   The `resumeRun` spy (#8093's regression) and ExecutionsToolOutput's
   `wakeIfOwed` spy stay: they mark a moment no published signal names, and
   neither fakes the process.

## What it costs

The SDK's `processLayer` gains a requirement, a breaking change to a 0.x
surface released with the next `sdk-v`; one line in each embedder. The
alternative, a `spawner` option on `ProcessLayerOptions`, is the knob
#14844 declined.

## Steps

One PR, three commits: the layer type and `texraProcessLayer` (with the API
report); the kernel's platform parameter and the scripted exit code; the two
suites.
