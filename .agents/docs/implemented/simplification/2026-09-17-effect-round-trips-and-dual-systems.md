# Effect round trips and dual systems: what the campaign left, and what not to re-mine

Date: 2026-09-17
Status: implemented. The clean-up this ledger planned ([#12681](https://github.com/LionSR/TeXRA/pull/12681))
ran as six waves and closed on 2026-09-19 at `aa79915095`, after 121 PRs
(#12693 to #12836). Every lane it named landed, was refuted, or was later
overtaken by the package split. This note keeps the two things a reader still
needs: the invariants the campaign established, and the candidates it refused.

Owner direction it served, still standing: no dual systems under Effect.
Convert the Promise twin and delete it; do not keep a wrapper beside it.

## What holds today

- No Effect-to-Promise-to-Effect round trip: no production function whose
  body only runs an Effect, and no port member kept Promise-shaped only
  because its port was. An `Effect.run*` outside the host entries and the SDK
  entry files fails ESLint (`no-restricted-syntax` in `eslint.config.mjs`);
  the SDK's pinned bare runs are `BARE_EFFECT_RUN_SITES` in
  `src/test-kernel/architecture/dependencyDirection.vitest.ts`.
- Production holds no `new AsyncLocalStorage`.
- No Promise filesystem: the `BaseFS` / `AbsoluteFS` / `WorkspaceFS` /
  `StorageFS` family, the `FileSystemProvider` port and `Platform.fs` are gone;
  code reads Effect `FileSystem` and the rooted views.
- `new AbortController()` is held to its two permanent residents
  (`packages/harness/src/agent/runtime/childRunLoop.ts`,
  `packages/texra/src/tools/claudeAgent.ts`) by ESLint; the rulings ledger
  records why.

The questions the surveys raised were ruled and live in the
[rulings ledger](../architecture/2026-08-01-architecture-rulings-ledger.md),
under "Eight rulings from the 2026-09-17 round-trip and dual-system survey"
and the 2026-09-19 entries after it.

## Refuted or declined at implementation

- **`createDesktopPtyHost` as an Effect**
  (`packages/desktop/src/main/desktopPtyHost.ts`, #12813): built, measured,
  reverted. Two of its catch sites are irreducibly synchronous
  (`handle.resize` after process exit, `handle.dispose` over `child.kill()`),
  so an Effect form needs `Effect.runSync` in a module that holds no runtime,
  which widens `BARE_EFFECT_RUN_SITES`. Measured cost: +21 LoC for one lift
  removed. The node-pty dynamic import is already a foreign edge wrapped once.
  Re-file once the host is handed a process runtime.
- **`installCliProcessRuntime` as an Effect program**
  (`packages/cli/src/runtime/cliProcessRuntime.ts`, #12828): refuted. It is
  the bootstrap edge itself, so there is no runtime to run it on, and an
  Effect face would force a bare `Effect.run*` at every citty action. It is a
  plain synchronous function returning the runtime, so nothing is left to
  lift.

## Refuted candidates (do not re-mine)

Round trips: `executeCommand` as one lifted lane (a program reached from
dozens of files, not a lane with one foreign edge; it is an `Effect.fn` in
`packages/harness/src/utils/system/execUtils.ts`); the `packages/llm`
interruption double wraps (deliberate); Ink `waitUntilExit` and
`vscode.commands.executeCommand` (foreign edges, each wrapped once).

Dual systems: the two host-request routers
(`packages/desktop/src/main/desktopHostRequests.ts`,
`packages/extension/src/progressView/extensionHostRequests.ts`: one union,
two hosts, a settled layout); the child run's `AbortController` (the SDK
strategies need a real signal); the docs-action channels; the
`openExternal` declarations; the `*_SETTING` descriptors; the three
workspace-file write vocabularies; the approval-policy host mirrors; the
trace domain escape hatch (only the `missingOutputs` double emit was real);
launch failure through three channels (ruled); refusal as failure versus
throw; failure classification markers; `ModelError` class-name sniffing (the
residue is precedence, not a dual); retry-policy synonyms (see
[effect facility adoption](./2026-09-20-effect-facility-adoption.md) for the
jitter helper); the onboarding and bypass copy; two subscription catalogs
(the browser-safe contract forbids merging; a third copy of display names is
the residue); availability versus usage route (the real item was a GLM
display bug); zero-cost route price override; `BoundModel` mirrors (only
`contextWindow` is derivable); `stream_id` at the usage boundary (ruled
permanent in the ledger); the trace-viewer dual load; the double-ledgered run
boundary; the double `shared -> agent` gate.
