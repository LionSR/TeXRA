# Effect-TS 4.0 adoption — assessment and strangler plan

**Status:** Proposed (2026-08-27). Assessment verified against branch HEAD
`d8c6dfc` (`chore: bump version to 0.40.6`, #11431) and against Effect
`4.0.0-rc.112` (the npm `rc` dist-tag on 2026-08-27; stable is still `3.22.1`).
No code changes land with this document.
**Scope:** Context/dependency injection across the whole tree — the `platform()`
service locator (`src/platform/platform.ts`), the `RunContext` ALS and
`RunScope` (`src/agent/runtime/`), the PocketFlow `Svc` channel
(`src/agent/node/index.ts`), session composition (`SessionHandle.ts`), the
global-setter long tail, cancellation and shutdown plumbing, and the test
substitution machinery in `src/test-kernel/support/`.
**Target:** Decide whether and how to adopt Effect 4 so that dependency
requirements are carried in types instead of enforced by runtime throws,
custom eslint rules, and mock-site ratchets — without violating the standing
resolve-once-at-boundary ruling and without a big-bang rewrite.
**Related:** [`2026-06-07-dependency-injection-cleanup.md`](./2026-06-07-dependency-injection-cleanup.md)
(steps 1–5 still open; this proposal subsumes their direction),
[`2026-08-16-services-injection-audit.md`](./2026-08-16-services-injection-audit.md)
(the standing "no new DI layer" ruling this proposal must answer),
[`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md),
`docs/architecture/2026-07-26-embedding-the-agent-runtime.md` (the bootstrap
ordering hazards that motivate this),
`docs/architecture/2026-06-20-pocketflow-state.md`.

---

## 1. The problem, measured

The pain being reported ("context injection is so painful") is not one bug; it
is that the codebase hand-implements an effect system's service layer, scope
system, and interruption model, and then hand-enforces the invariants the type
system cannot see. Measured at HEAD:

**Service location, not injection.**

- `src/platform/platform.ts` is a module-level nullable frozen singleton with
  14 ports. `platform()` is called **339 times across 142 files**, at arbitrary
  depth — leaf utilities (`src/utils/files/baseFS.ts` alone has 13 calls),
  tools, model routing, LaTeX code, the agent runtime. Nothing takes a
  `Platform` parameter.
- Init-order fragility is documented in the code itself: the
  `getConfigBeforePlatformInit()` escape hatch
  (`src/utils/config/configUtils.ts`), `tryPlatform()` /
  `tryGlobalState()` / `tryWorkspaceState()`, and "constructs before
  `initPlatform()` runs" comments in `src/latex/latexdiff.ts`,
  `src/tools/goal/goalStore.ts`, `src/tools/lean/direct/directLspAdapter.ts`,
  among others.
- Beyond the platform there are **53 module-level `let` singletons** in non-test
  `src/` and **33 exported `set*`/`register*`/`install*`/`init*` global
  installers** (`setOutputChannelFactory`, `registerAgentFeatures`,
  `initNodeAgentRuntime`, `setSetupPlatform`, `installTexraAccountProbes`, …),
  each with its own once-only throw or idempotence check.
  `packages/agent/src/index.ts:240-246` even has to detect "another platform is
  already active in this process" — an error class that exists only because the
  platform is process-global.

**Ambient context re-implemented.** `src/agent/runtime/RunContext.ts` is an
`AsyncLocalStorage<RunContext>` with typed accessors, a `bare` variant that
exists only to make the ALS testable, and a documented push *away* from it
(`src/agent/core/flows/BaseFlowServices.ts:17-33` moved three flags off the ALS
"so flows can run without an `AsyncLocalStorage` frame — the property an SDK
embedder wants"). `RunScope` carries a sticky `AbortSignal` composed via
`AbortSignal.any` (`AgentLaunchContext.ts`), with `throwIfAborted()` checkpoints
sprinkled by hand. `LifecycleHost.onShutdown(phase, cb(signal))` is a
hand-rolled finalizer stack.

**Requirements enforced at runtime, not compile time.** The flow engine's
services channel throws `'Node services accessed before Flow.setServices()
populated them.'` (`src/agent/node/index.ts`). `platform()` throws
`'Platform not initialized'`. `defaultSession()` (referenced from 80 files)
throws when nothing initialized it and *warns* when a non-default session is
live — a heuristic where a type would do.

**A bureaucracy that substitutes for types.** Because none of the above is
visible in signatures, the repo maintains: a custom eslint rule
(`local/no-platform-init-outside-composition-root`, `eslint.config.mjs:333`)
with a hard-coded five-file allowlist; the `host-agent-mock` ratchet
(`config/ratchets/host-agent-mock-baseline.json`), which pins every `vi.mock`
of an internal `@agent/*` path from host tests precisely because there is no
type-level way to hand a test a fake runtime; and 835 vitest suites that all
bootstrap through one global `installPlatform()` setup file
(`vitest.config.mjs:33` → `src/test-kernel/support/setupFakePlatform.ts`), with
a dozen suites still hand-rolling `initPlatform` on the side.

Every row of that list is a thing Effect's `R` channel, `Layer`, `Scope`, and
fiber interruption provide natively, with the invariant checked by `tsc`
instead of by throws and baseline JSON.

## 2. What Effect 4 actually is (as of the RC)

State of the release, verified 2026-08-27:

- `effect@4.0.0-rc.112` is on npm under the `rc` dist-tag. The core team's RC
  announcement states "no more broad breaking changes planned"; the remaining
  work to stable is regression-fixing. Community projects have run the v4 beta
  in production for months.
- **One package, one version.** `@effect/platform`, `@effect/rpc`,
  `@effect/cluster` etc. are folded into `effect` core; all ecosystem packages
  share a single version. This kills the v3-era version-matrix problem and
  means we would add exactly one dependency.
- **Stability tiers.** Modules under `effect/*` follow strict semver from 4.0;
  modules under `effect/unstable/*` (notably `schema`, `http`, `cli`, `ai`) may
  break in minors. Anything we adopt from `unstable/` is a risk we opt into
  per-import.
- **Services/DI surface (v4 names).** All v3 service-definition APIs collapse
  into `Context.Service`:

  ```ts
  class Fs extends Context.Service<Fs, FileSystemProvider>()("texra/Fs") {}

  const FsLive = Layer.succeed(Fs, nodeFilesystem)

  const program = Effect.gen(function* () {
    const fs = yield* Fs
    yield* Effect.promise(() => fs.stat(path))
  })
  ```

  Layers are built explicitly (`Layer.effect(Service, make)` +
  `Layer.provide(...)`; the v3 `dependencies` option and auto-generated
  `.Default` layers are gone). Fiber-locals are `Context.Reference` with a
  `defaultValue`. `Runtime<R>` is removed; the runtime was rewritten (smaller,
  faster, ~6 KB min+gz for a minimal program).
- **Irrelevant to us:** the v3→v4 codemods and `catch*` renames. TeXRA has zero
  Effect today (confirmed against `pnpm-lock.yaml`; the only FP residue is
  `neverthrow` in exactly two files, `src/common/parsing/safeParse{Json,Yaml}.ts`).
  This is greenfield *adoption*, not migration — we get to start on the v4 API
  with no v3 habits to unlearn.

## 3. The objection this proposal must answer

The 2026-08-16 services-injection audit records the standing ruling: the
agent-core disease was dual ownership, and the cure is *single owner +
resolve-once-at-boundary, achieved by deletion — never by another DI layer*.
An Effect proposal that ignores this is dead on arrival, so state the position
plainly:

**Effect used as a DI framework would violate the ruling. Effect used to
delete the hand-built enforcement layer honors it.** The test is the same one
the ruling applies everywhere: net deletion, seam by seam. A seam migrates only
when the Effect version removes more than it adds — the runtime throw, the
escape hatch, the eslint allowlist entry, the ratchet rows, the `vi.mock`
sites, the hand-rolled queue/retry/abort plumbing around it. A seam where
Effect would merely re-house working code (wrap a working Promise API in
`Effect.promise` for purity's sake) does not migrate. §6 lists the seams that
fail this test and stay as they are.

Two facts make the deletion case unusually strong here rather than
hypothetical:

1. The codebase has already **converged on Effect's shapes by hand**:
   `createNodePlatform(services)` (`src/platform/defaults/nodeHost.ts:113`) is
   a Layer constructor in all but name; `SessionHandleInit`'s partial-override
   record is `Layer` + `Layer.succeed` overrides; `RunContext` is
   `Context.Reference`; `RunScope.signal` is fiber interruption;
   `LifecycleHost` is `Scope`. The 2026-06-07 DI plan and the SDK-embedding
   note both push in this direction; Effect is the version of that endpoint
   where `tsc` enforces it.
2. The enforcement bureaucracy is **enumerable and deletable**: the
   `host-agent-mock` ratchet + its architecture test, the composition-root
   eslint rule, the `tryPlatform`/`getConfigBeforePlatformInit` hatches, the
   `bare` RunContext arm, the `setServices` runtime throw, the
   "already using another platform" conflict check. Each phase below names
   which of these it deletes; a phase that deletes none of them is cut.

## 4. Options considered

**(a) Full migration** — rewrite the tree onto Effect (errors as typed `E`
channels, Streams everywhere, Zod→Schema). Rejected. 176 kLOC of production
code plus 244 kLOC of tests; 245 files import Zod v4, which is the schema SSOT
per CLAUDE.md while Effect's own Schema sits in `unstable/`; 908 `throw` sites
whose conversion to typed errors is an ocean-boiling project with no incremental
payoff. This is years, and most of it fails the net-deletion test.

**(b) No Effect** — keep executing the 2026-06-07 DI plan by hand. Viable but
asymptotically worse: every cleanup step re-implements a piece of an effect
system (the BaseFlowServices flag-move is exactly "make requirements explicit"
done manually, one field at a time) and the enforcement bureaucracy never
becomes deletable because the types never learn about requirements.

**(c) Strangler adoption at the DI/lifecycle seams — recommended.** Adopt
`effect` core for services, scoping, and interruption in the layers where the
hand-rolled machinery lives, keep Promise-based public APIs at every existing
boundary (`Effect.runPromise` at the edges, which also gives `AbortSignal`
interop for free), and leave schemas, wire contracts, and webviews untouched.
Each phase is independently shippable and independently abandonable.

## 5. The plan

Ordering principle: start where the blast radius is smallest per consumer
(facades already funnel most call sites) and the deleted machinery is largest.
Every phase ends green on `npm run typecheck`, `npm test`, `npm run lint`, and
the ratchets.

### Phase 0 — spike and guardrails (1 PR)

- Add `effect@4.0.0-rc.112` (exact pin; bump deliberately per RC, move to `^4`
  at stable) to the root workspace.
- Decide and enforce **where Effect may appear**: extend `eslint.config.mjs`
  with a boundary — no `effect` imports in webview frontends or
  `src/shared/` (wire contracts stay dependency-free); everywhere else
  allowed. Effect has no `vscode` dependency, so the VS Code-free zones are
  unaffected.
- Write the two interop conventions down in AGENTS.md:
  - Boundary rule: public surfaces (`runAgent`, controllers, host entry
    points) keep their current Promise signatures; Effect code is run with
    `Effect.runPromise(effect, { signal })` at the boundary so existing
    `AbortController` callers compose with fiber interruption unchanged.
  - Expected-vs-defect rule: the existing `ToolResult` contract
    (`src/agent/core/tools/ToolTypes.ts:16-22` — expected failures as values,
    programmer failures thrown) maps to `E` channel vs `Cause.Die`; nothing
    about the wire schema changes.
- Spike deliverable: one leaf port (`fileLocks` — `runExclusive` is already a
  scoped-resource shape) defined as a `Context.Service` + Layer, consumed from
  one call site, proving the toolchain (esbuild/Vite bundling, typecheck cost,
  test wiring) end to end. Measure `npm run typecheck` wall-clock before/after;
  Effect's types are heavy and this is the abort criterion — if typecheck
  degrades materially on the spike, stop and report.

### Phase 1 — the Platform as Layers (the core payoff)

- Define one `Context.Service` per Platform port (14 tags, same interfaces —
  `interfaces.ts` contracts are unchanged). `createNodePlatform` becomes
  `platformLayer(services: NodePlatformServices): Layer<...>` — it is already
  that function.
- **Compatibility shim, not flag-day:** `initPlatform(services)` remains, now
  building the ServiceMap once and stashing it; `platform()` reads through it.
  All 339 call sites keep working untouched. New/migrated code takes the
  service from context instead.
- Migrate the three facade families that concentrate consumption:
  `@utils/config` (82 importers), `@utils/files/storageFS` (47 importers), and
  the `baseFS`/`workspaceFS` family. Internally they resolve services once at
  their boundary — which is the standing ruling's own prescription — while
  their exported signatures stay put.
- Deletes: the `packages/agent` "already using another platform" conflict
  check (two Layers can coexist in one process), the CLI's
  `if (!tryPlatform())` idempotence guard, and — once direct `platform()`
  callers in a given subsystem hit zero — the `tryPlatform`/`tryGlobalState`/
  `tryWorkspaceState`/`getConfigBeforePlatformInit` hatches for that subsystem.

### Phase 2 — run scope: interruption and finalizers

- `RunScope` + `withExecutionRunContext` become a per-run provided context;
  the ALS accessors (`useRunContext` in 28 files, `getRunContext*` in 26)
  become service reads. The `bare` test-only arm is deleted outright.
- `RunScope.signal` / `AbortSignal.any` composition becomes fiber
  interruption; `input.signal?.throwIfAborted()` checkpoints disappear
  (interruption is checked at every yield). At the boundary,
  `runPromise(..., { signal })` preserves the external contract.
- `LifecycleHost`'s two-phase shutdown maps onto `Scope` finalizers (ordering
  preserved; finalizers run LIFO within a scope).
- Deletes: the ALS module's dual-variant machinery, the hand-rolled abort
  composition in `AgentLaunchContext.ts`, and the per-site checkpoint calls.

### Phase 3 — concurrency and event plumbing (opportunistic, per-file)

Not a sweep — convert only when already touching a file for other reasons:
`p-queue` (36 files) → `Semaphore`/`Queue`; `p-retry` (10 files) →
`Effect.retry` + `Schedule` (this also aligns with `ModelInvocationNode`'s
manual-retry loop, the one place CLAUDE.md documents bespoke retry policy);
`KeyedMutex`/`perKeyQueue` → keyed semaphores; `SessionEventHub` →
`PubSub` + filtered `Stream` when a consumer actually needs backpressure or
stream composition. `appSignals` explicitly stays (see §6).

### Phase 4 — the flow engine's `R` channel

The deepest change, last because Phases 1–2 make it mechanical:
`BaseNode<S, Svc>`/`Flow.setServices()` (`src/agent/node/index.ts`, 159 LOC,
ours to change) carries `Svc` through the type system as `R` instead of a
mutable field — node `exec` becomes `Effect<A, E, R>` and the
`'Node services accessed before Flow.setServices()'` throw becomes a compile
error. `AgentCore`/`CycleRunServices` (`BaseFlowServices.ts`,
`CycleServices.ts`) become context requirements instead of threaded bags.
`persistedFlow.ts` checkpointing is unaffected: state slices (`S`) stay the
Zod-validated snapshots documented in `2026-06-20-pocketflow-state.md`;
only the services channel changes vehicle.

### Phase 5 — tests inject Layers; the bureaucracy is deleted

- `createFakePlatform` becomes `fakePlatformLayer(options, overrides)` — same
  642-LOC in-memory implementation, provided per-suite instead of installed
  globally. The global setup file shrinks to providing the default layer.
- Host tests that today `vi.mock` internal `@agent/*` modules get handed a
  fake runtime layer instead; each converted suite removes rows from
  `host-agent-mock-baseline.json` until the ratchet and
  `hostAgentMockRatchet.vitest.ts` are empty and deleted.
- With `initPlatform` gone from production, delete
  `local/no-platform-init-outside-composition-root` and its allowlist.

Exit criteria for the whole effort, in measurable form: `platform()` call
count 339 → 0; `host-agent-mock-baseline.json` deleted; the composition-root
eslint rule deleted; the pre-init escape hatches deleted; module-level
`let` singleton count 53 → the handful with a written justification.

## 6. What does not migrate (and why)

- **Zod.** 245 importing files; CLAUDE.md names Zod schemas the single source
  of truth; Effect's Schema lives under `unstable/` in v4. Interop where
  needed is `Effect.try` around `.parse` — nothing more. Revisit only after
  Schema graduates from `unstable/`, and even then only with a net-deletion
  case.
- **Webview frontends and `src/shared/`.** Wire contracts and browser
  bundles gain nothing from an effect runtime; the browser-safe-utils
  constraint stays as is.
- **`appSignals`.** 140 LOC, seven signals, already has `AbortSignal`
  unsubscribe and a documented scope. Rewrapping it fails the net-deletion
  test.
- **The 908 `throw` sites and 46 error classes.** Errors become typed `E`
  values only where a seam migrates anyway (tool dispatch, retry); no
  error-modeling campaign.
- **`neverthrow`.** Retired into plain Effect (or plain throws) when Phase 3
  touches the two parse helpers; not before.

## 7. Risks, honestly

- **RC is not stable.** rc.112 with "no broad breaks planned" is a strong
  signal, not a guarantee; anything from `unstable/*` is explicitly exempt
  from that promise. Mitigation: exact-pin the version, import nothing from
  `unstable/`, and treat Phase 0+1 as the only phases started before 4.0
  stable ships.
- **Typecheck and TS-server cost.** Effect-heavy code is demanding on `tsc`
  and editors, and this repo already has 1,800+ TS files with a
  builds-don't-typecheck footgun. The Phase 0 measurement is a hard gate.
- **Two-worlds period.** Until a subsystem finishes, it has both `platform()`
  and context-based access. The compat shim keeps this safe (one underlying
  ServiceMap, so no dual ownership — same object, two access paths, which is
  the pattern the 2026-08-16 audit already blessed for `RunScope`), but the
  period should be bounded per subsystem, not open-ended.
- **Team surface area.** Generators-as-do-notation, Layers, and fiber
  semantics are a real learning curve, and agent-authored PRs will need the
  conventions written down (Phase 0's AGENTS.md section) to stay idiomatic.
- **The colored-function seam.** Every Promise↔Effect crossing is a little
  friction (`Effect.promise`/`Effect.tryPromise` inward, `runPromise`
  outward). Keeping the public surfaces Promise-based confines this to
  interior seams, but it never fully disappears while both worlds exist.

## 8. Recommendation and first step

Adopt option (c). The first concrete PR is Phase 0 exactly as scoped: the
dependency pin, the eslint boundary, the AGENTS.md interop conventions, the
`fileLocks` spike, and the typecheck timing measurement — small enough to
review in one sitting, and it produces the number (typecheck cost) that
decides whether the rest of the plan proceeds.
