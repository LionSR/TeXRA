---
created: 2026-05-06
updated: 2026-06-07
---

# PRD: RunContext + ambient-state retirement

**Status:** Draft (v1 — extracted from `2026-05-04-prd-cli-app.md` round 2 §§22, 29; 2026-05-05)
**Owner:** TBD
**Date:** 2026-05-05
**Branch:** `claude/refactor-texra-cli-tOC5U`
**Companions:** [`2026-05-04-prd-cli-app.md`](./2026-05-04-prd-cli-app.md), [`2026-05-02-prd-electron-app.md`](./2026-05-02-prd-electron-app.md), [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md)

## 1. Summary

The TeXRA agent runtime today reaches host services through two ALS scopes plus 19 module-level `let X | undefined` setter pairs and three exported singleton coordinators. That ambient-state model is fine for the VS Code extension (one process, one user, one runtime host) but leaks under three workloads the next 12 months will bring:

- The **CLI's `texra mcp serve`** mode, which must host N concurrent sessions per process (one per MCP `tools/call`).
- A **re-entrant SDK** — multiple `Promise.all([runAgent(...), runAgent(...)])` calls from a single Node process.
- An eventual **`texra serve` daemon** or **embedded library** that runs many users' workloads in one process.

This PRD specifies the refactor: a single explicit `RunContext` value carrying every per-run service (progress sink, logger, abort signal, approval policy, coordinators, capabilities), threaded through the kernel call graph; one ALS scope at the outermost entry point as a migration ergonomics shim; and a phased deletion of the 19 singleton bindings the audit names. It also specifies the three-ring layering of `packages/core/` that this work makes legible.

The kernel migration is independently valuable to all three hosts (extension, desktop, CLI) and does not gate any v1 CLI deliverable except `texra mcp serve` v1.1 (true session concurrency).

## 2. Goals

- Replace every implicit lookup of `defaultProgressSink`, `defaultAgentRuntimeHost`, `runStorageService`, the singleton approval coordinators (`planApprovalCoordinator`, `proposalCoordinator`, `retryCoordinator`), and per-run/per-domain setters (`setToolEditApprovalHandler`, `setGitHubTokenProvider`, …) with explicit `RunContext` access. Process-lifetime host capabilities such as external tool availability belong on `Platform` ports instead.
- Provide a single ALS scope at the outermost agent-execution boundary so existing call sites can adopt `RunContext` mechanically without a 30-file PR.
- Delete the singletons in retirement waves; each wave is independently mergeable and shrinks the ambient surface monotonically.
- Lock in the three-ring structure under `packages/core/` (pure logic / runtime orchestration / platform defaults) so a new host adapter (Tauri, daemon, embedded SDK) needs only Ring 3 + a thin host package — no Ring 1 or Ring 2 changes.
- Add an ESLint rule blocking new module-level `let X | undefined` + setter pairs in the agnostic zones, so this never grows back.

## 3. Non-goals

- **Not** a pure-explicit refactor — we keep one ALS scope (`runContextScope`) for ergonomic adoption. The OpenTelemetry, Vercel AI SDK, and Encore ecosystems all settled on this hybrid; we copy that.
- **Not** an OS-level sandbox / capability-based-security project. `RunCapabilities` is a _value-typed_ capability bag ("does this run have a github token?"), not a syscall sandbox.
- **Not** an attempt to delete `getConfig`-style platform service lookups. `platform()` from `@platform` is composition-root state, not per-run state, and stays.
- **Not** a rewrite of any modelHandler, flow node, or tool. Their interfaces gain a `ctx: RunContext` parameter; their bodies do not change.
- **Not** a host-specific logger redesign. Logger v2 is its own PRD (`2026-05-06-prd-logger-v2.md`); this PRD only states that `Logger` is a field on `RunContext`.

## 4. Background — what's ambient today

A May 2026 audit of `src/agent/`, `src/tools/approval/`, `src/auth/`, `src/eventBus/`, and `src/logger/` enumerated every cross-call-site state binding. The full inventory:

### 4.1 AsyncLocalStorage scopes (2)

| Scope              | File:line                                  | Holds                                               | Entered by                                    | Read by                                                                                                                |
| ------------------ | ------------------------------------------ | --------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `runtimeHostScope` | `src/agent/runtime/AgentRuntimeHost.ts:12` | Current `AgentRuntimeHost` (≡ `ProgressSink`)       | `runWithAgentRuntimeHost(host, fn)` (line 27) | `getAgentRuntimeHost()` (line 23) — falls back to `defaultAgentRuntimeHost` (line 11), then `getDefaultProgressSink()` |
| `contextStorage`   | `src/logger/logUtils.ts:10`                | `Map<channel-key, group-id stack>` for log grouping | `runWithGroupContext()` (line 130)            | `getActiveGroupStack()` (line 63), `runWithGroupContext` (line 136)                                                    |

### 4.2 Module-level setter/getter pairs (19)

| Concern                         | Setter                            | File:line                                          |
| ------------------------------- | --------------------------------- | -------------------------------------------------- |
| Default progress sink           | `setDefaultProgressSink`          | `src/agent/runtime/ProgressSink.ts:14`             |
| Default runtime host            | `setDefaultAgentRuntimeHost`      | `src/agent/runtime/AgentRuntimeHost.ts:11`         |
| Run storage service             | `setRunStorageService`            | `src/agent/runtime/RunStorageService.ts:10`        |
| Tool-edit approval handler      | `setToolEditApprovalHandler`      | `src/tools/approval/toolEditApproval.ts:74,113`    |
| Latex build-display handler     | `setOpenBuildDisplay`             | `src/tools/approval/latexPreview.ts:22,24`         |
| GitHub token provider           | `setGitHubTokenProvider`          | `src/tools/github/githubAuth.ts:13`                |
| External tool host availability | `platform().toolAvailability`     | `src/platform/interfaces/toolAvailability.ts`      |
| Linter provider                 | `setLinterProvider`               | `src/tools/DiagnosticsTool.ts:10,12`               |
| Lean VS Code services           | `setLeanVscodeServices`           | `src/tools/lean/leanVscodeServices.ts:45,47`       |
| Setup platform                  | `setSetupPlatform`                | `src/tools/setup/platform.ts:108,111`              |
| Tool-unavailable notification   | `setToolNotificationHandler`      | `src/tools/toolUnavailableNotification.ts:21,28`   |
| Worktree support flag           | `setWorktreeSupportEnabled`       | `src/tools/worktreeConfig.ts:12,14`                |
| Server-side key service         | `setServerSideKeyService`         | `src/auth/serverKeys/index.ts:34`                  |
| Tier service                    | `setTierService`                  | `src/auth/tier/index.ts:31`                        |
| Auth callback resolver          | `setExternalAuthCallbackResolver` | `src/auth/config.ts:183`                           |
| Runtime extension id            | `setRuntimeExtensionId`           | `src/auth/config.ts:137`                           |
| Output-channel factory (logger) | `setOutputChannelFactory`         | `src/logger/logUtils.ts:108`                       |
| Default stream-log store        | `setDefaultStreamLogStore`        | `src/logger/StreamLogStore.ts:668,675`             |
| Agent directories               | `setAgentDirectories`             | `src/agent/index/agentDirectoriesRegistry.ts:8,11` |

Counted via `git grep "^export function set[A-Z]" packages/core/src/{agent,tools,auth,logger,eventBus}/` against the v1 audit cutoff. The list is exhaustive within those zones; categories outside (e.g. `src/extension/`) are intentionally excluded.

### 4.3 Exported singleton coordinators (3)

- `planApprovalCoordinator` — `src/agent/runtime/PlanApprovalCoordinator.ts:128`
- `retryCoordinator` — `src/agent/runtime/RetryRequestCoordinator.ts:145`
- `proposalCoordinator` — `src/agent/runtime/AgentProposalCoordinator.ts:89`

These are problematic because they fan out events to whoever the current global handler is — concurrent runs leak approval prompts between sessions.

### 4.4 Caches that survive across runs (4)

- Agent-registry cache + init promise — `src/agent/index/agentRegistry.ts:143,146-147`
- Execution listing cache + workspace-path cache — `src/agent/storage/executionListing.ts:52-54`
- Output-poll timer + in-flight flag — `src/agent/runtime/executionRegistry.ts:335-336`
- Polish-model template cache — `src/agent/runtime/polishModel.ts:11-12`

These are intentional caches of _immutable_ data (registry, model templates) and stay. They are not the target of this PRD; they're listed only to bound the audit.

### 4.5 Why this is the right time

Three concurrent forces:

1. **CLI v1 is in flight** (`2026-05-04-prd-cli-app.md`). Round 2 of that PRD names `texra mcp serve` as a v1 deliverable. MCP-server safety with concurrent sessions requires per-context coordinators; that's the v1.1 milestone of this refactor.
2. **The host-neutral split is at the right point.** Per `2026-05-02-prd-electron-app.md` §9, almost all VS Code-coupling has been factored out. The remaining hot spot — ambient runtime state — is the natural next refactor before the kernel moves into `packages/core/`.
3. **Tests already pay the cost.** `setDefaultProgressSink(noop)` and `setRunStorageService(fake)` calls in `beforeEach` / `afterEach` total ~150 LOC across the test suite. Removing them is a strict win for test hermeticity.

## 5. The shape: `RunContext`

A single value, threaded through the kernel call graph, carrying every per-run service.

```ts
// packages/core/src/runtime/runContext.ts
export interface RunContext {
  /** Stable identifier for this run; root for child contexts. */
  readonly runId: RunId;
  /** Stream tab id within the run (one per agent activation). */
  readonly streamId: StreamTabId;

  /** Where progress events go. Replaces `getAgentRuntimeHost()`. */
  readonly progress: ProgressSink;
  /** Structured logger scoped to this run. (See 2026-05-06-prd-logger-v2.md.) */
  readonly log: Logger;

  /** Cooperative cancel signal. Replaces InterruptManager-as-singleton. */
  readonly signal: AbortSignal;

  /** Approval policy for this run (resolved from flag > env > config > schema default). */
  readonly approval: ApprovalPolicy;

  /** Workspace root (cwd) for this run — per-run override of WorkspaceProvider. */
  readonly workspaceRoot: string;

  /** Runtime-resolved capabilities. Replaces per-run lookups such as setGitHubTokenProvider, … */
  readonly capabilities: RunCapabilities;

  /** Coordinators bound to this run's progress sink. Replaces the three exported singletons in §4.3. */
  readonly coordinators: {
    plan: PlanApprovalCoordinator;
    proposal: AgentProposalCoordinator;
    retry: RetryRequestCoordinator;
  };

  /** Spawn a child context for a delegate_agent / delegate_workflow subagent. */
  child(opts: ChildContextOptions): RunContext;
}

export interface RunCapabilities {
  github: GitHubTokenProvider | null;
  extensionPresent: boolean;
  externalAuthCallback: ExternalAuthCallbackResolver | null;
  // …other host capabilities the host adapter populates at run start
}

export interface ChildContextOptions {
  streamId: StreamTabId;
  // override fields the child should diverge on (e.g., a child's signal
  // chains from the parent's via AbortSignal.any)
  approval?: ApprovalPolicy;
}
```

`buildAgentLaunchContext()` in `executeAgent.ts:583` already constructs almost all of this; the refactor is to (a) lift it to the kernel boundary so it's the only entry point that matters, (b) rename it `buildRunContext()`, and (c) pass the result explicitly into every coordinator method that today reads from a singleton.

## 6. Migration shim — one ALS, gradual cutover

Because the audit found ~30 reader sites of singletons today, a hard cutover is unrealistic. The shim:

```ts
// packages/core/src/runtime/runContext.ts
export const runContextScope = new AsyncLocalStorage<RunContext>();

export function withRunContext<T>(
  ctx: RunContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return runContextScope.run(ctx, fn);
}

export function useRunContext(): RunContext {
  const ctx = runContextScope.getStore();
  if (!ctx) {
    throw new Error('useRunContext() called outside withRunContext()');
  }
  return ctx;
}

export function tryUseRunContext(): RunContext | undefined {
  return runContextScope.getStore();
}
```

- Every `executeAgent()` call becomes `withRunContext(ctx, () => /* existing body */)`.
- The existing `runWithAgentRuntimeHost()` keeps working — it now reads from `runContextScope.getStore()?.progress` and falls back to its current path.
- Every singleton getter (`getDefaultProgressSink`, `getRunStorageService`, `getServerSideKeyService`, …) gets a `// LEGACY:` comment plus a path forward: read `runContextScope.getStore()?.<field>` first, fall back to the module global, log a `DEBUG` if the fallback was used.
- Internal kernel call sites convert in batches (one per phase). Each batch deletes a module global once _all_ its readers take an explicit `ctx`.

## 7. Migration phases

Each phase is independently mergeable and ships a concrete kernel improvement.

### Phase 0 — Foundations (~1.5 weeks)

- Add `packages/core/src/runtime/runContext.ts` with the interface, the scope, and `withRunContext` / `useRunContext` / `tryUseRunContext` / `child()`.
- Wire `withRunContext` at every `executeAgent()`, `executeMergeAgent()`, `resumeToolUseFromSnapshot()` call site.
- Rename `buildAgentLaunchContext` → `buildRunContext` and have it return a `RunContext` directly (instead of the bag of fields it currently returns).
- Test harness: `withRunContext(synthesizedContext, fn)` available from `packages/core/src/runtime/testing.ts`.
- Add ESLint rule `no-ambient-runtime-state` that flags new `let X: T | undefined` + `setX` pairs in `packages/core/src/agent/`, `core/tools/`, `core/auth/`. Existing pairs are grandfathered with `// eslint-disable-line` + `// PRD: 2026-05-06-prd-runcontext-refactor.md` comments to make them visible at sweep time.
- **Exit criteria:** every entry from `executeAgent()` runs inside a `withRunContext`. The grandfathered list of `eslint-disable` lines exactly matches §4.2's table.

### Phase 1 — Per-context coordinators (~1 week)

- `planApprovalCoordinator`, `proposalCoordinator`, `retryCoordinator` are no longer module-level exports. They become factories (`createPlanApprovalCoordinator(ctx)`) and instances live on `ctx.coordinators`.
- The same three coordinators today extend `BasePromiseCoordinator`, which holds a `Map<streamId, Resolver>`. Per-context instances close over the run's stream lineage; cross-stream interference goes away.
- Update ~5 reader sites (mostly inside `tools/approval/` and `agent/runtime/`).
- **Exit criteria:** the three singleton exports are deleted from `PlanApprovalCoordinator.ts:128`, `RetryRequestCoordinator.ts:145`, `AgentProposalCoordinator.ts:89`. CI passes; no `let coordinator = new …Coordinator()` remains.

### Phase 2 — Progress sink + runtime host singleton retirement (gates `texra mcp serve` v1.1) (~1.5 weeks)

- Delete `defaultProgressSink` (`ProgressSink.ts:14`), `defaultAgentRuntimeHost` (`AgentRuntimeHost.ts:11`), and the entire fallback chain in `getAgentRuntimeHost()` (`AgentRuntimeHost.ts:24`).
- Delete `setDefaultProgressSink`, `setDefaultAgentRuntimeHost`, `getDefaultProgressSink`. The only valid path to a sink is `useRunContext().progress`.
- Delete `runStorageService` singleton (`RunStorageService.ts:10`); per-context storage handle on `ctx.coordinators` (or its own `ctx.storage` field if the API justifies it).
- Walk the remaining ~40 reader sites; convert each to `useRunContext().progress` / `tryUseRunContext()`. The audit lists 0 reader sites outside `getStore()`-aware code, so this is mechanical.
- **Exit criteria:** `git grep "defaultProgressSink\|defaultAgentRuntimeHost\|runStorageService = "` returns zero hits in `packages/core/`. `texra mcp serve` integration test (`2026-05-04-prd-cli-app.md` §30.3) runs two concurrent `tools/call`s with no progress-event interleaving.

### Phase 3 — Approval handlers + capabilities injection (~1 week)

- `setToolEditApprovalHandler` (`toolEditApproval.ts:74`), `setLatexBuildDisplay` (`latexPreview.ts:21`), `setGitHubTokenProvider` (`githubAuth.ts:13`) — replaced by `RunCapabilities` injection. Process-lifetime host checks should remain on typed `Platform` ports.
- The host adapter populates `RunCapabilities` once when building the `RunContext`. No more "the global was set during boot but the test forgot to clear it."
- **Exit criteria:** the four setters and their backing `let` declarations are deleted; `RunCapabilities` covers their use cases.

### Phase 4 — Auth singletons (~1 week)

- `tierService` (`auth/tier/index.ts:31`), `serverSideKeyService` (`auth/serverKeys/index.ts:34`), `externalAuthCallbackResolver` (`auth/config.ts:183`), `runtimeExtensionId` (`auth/config.ts:137`) — replaced by per-`RunContext` resolutions backed by a kernel-side `AuthRegistry`.
- The auth registry itself is composition-root state (initialized once at `initPlatform()`), so it's allowed to be a module global; what's _per-run_ is which session/keys/tier resolution applies. That distinction collapses today.
- **Exit criteria:** auth tests no longer install global services in `beforeEach`.

### Phase 5 — `then()`-boundary fix + sweep (~3 days)

- The LangSmith-style "ALS lost across `.then()`" foot-gun: `RunStorageService`'s background poll timer (`executionRegistry.ts:335`) currently fires outside any context scope. Refactor `pollInFlight` from `bool` to `Map<RunId, RunContext>` and wrap the timer callback in `withRunContext(stored, fn)`.
- ESLint sweep: remove every `// PRD: 2026-05-06-prd-runcontext-refactor.md` grandfather comment introduced in Phase 0. The list shrinks to zero by definition once Phases 1–4 land.
- **Exit criteria:** zero ambient-state lints disabled in agnostic zones. `git grep "let .*: .* | undefined" packages/core/src/agent packages/core/src/tools packages/core/src/auth | grep -v test` returns only legitimate caches (the four §4.4 entries).

### Aggregate timeline

| Phase     | Singletons retired                                                    | Files touched                                                                  | Net LOC         | Engineering weeks |
| --------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | ----------------- |
| 0         | — (foundations)                                                       | `runContext.ts` (new), `executeAgent.ts`, `runtime/testing.ts`                 | +220 / -10      | 1.5               |
| 1         | 3 coordinators                                                        | `Plan/Retry/AgentProposalCoordinator.ts` + 5 readers                           | +60 / -30       | 1                 |
| 2         | `defaultProgressSink`, `defaultAgentRuntimeHost`, `runStorageService` | `ProgressSink.ts`, `AgentRuntimeHost.ts`, `RunStorageService.ts` + ~40 readers | +20 / -160      | 1.5               |
| 3         | 4 capability setters                                                  | `tools/{approval,github,externalToolDefs}/*`                                   | +60 / -110      | 1                 |
| 4         | 4 auth singletons + extension-id setter                               | `auth/*`                                                                       | +80 / -130      | 1                 |
| 5         | (sweep)                                                               | `executionRegistry.ts` + lint rule cleanups                                    | +20 / -30       | 0.5               |
| **Total** | **19 ambient bindings + 3 coordinators**                              |                                                                                | **+460 / -470** | **~6.5**          |

Net code change: **~-10 LOC** (the refactor pays for itself in deleted boilerplate). The CLI consumes Phase 1 deliverables for v1.0 and Phase 2 for v1.1; the extension and desktop benefit from every phase but don't gate on them.

## 8. Three-ring kernel structure (`packages/core/`)

The audit revealed three categories of shared code that today live mixed together. Round 2 of the CLI PRD §29 sketched this; this PRD makes it normative.

### 8.1 The rings

**Ring 1: pure logic** (zero host coupling, zero ALS).

- `core/agent/` minus runtime — every modelHandler, every flow, every node, every reasoning strategy.
- `core/model/`, `core/latex/`, `core/replacement/`.
- `core/eventBus/` — schemas only, no emitters.
- `core/tools/` minus `core/tools/approval/`.
- `core/shared/` — IPC schemas, including `runStream.ts` (the unified log+progress envelope from `2026-05-06-prd-logger-v2.md`).

These take a `ctx: RunContext` argument (post-this-PRD) but never reach for the ambient store. Test harnesses synthesize a `RunContext` and never need a fake host.

**Ring 2: runtime orchestration** (consumes `RunContext`; no `vscode`/`electron`/`process` access).

- `core/runtime/` — `RunContext`, `Logger` interface, `ProgressSink` interface, `executeAgent`, all coordinators.
- `core/tools/approval/` — gates and controllers.
- `core/auth/` — `SupabaseSessionCoordinator`, `TierService`, `ServerSideKeyService` (post-Phase-4 per-context).
- `core/hosts/` — every host port (`PromptHost`, `ExternalOpener`, `DiffViewHost`, `TerminalHost`, `ClipboardHost`, plus `LogSink` from `2026-05-06-prd-logger-v2.md`, plus `HookHost` and `SessionStore` from forthcoming PRDs).
- `core/storage/sessionStore.ts` (interface only; impls in Ring 3).

These import Ring 1 freely and accept host services through their constructor / `RunContext` — but they never `import 'vscode'`, never `import 'electron'`, never `process.exit`.

**Ring 3: platform defaults** (Node-only; no `vscode`/`electron`).

- `core/platform/defaults/` — today's `consoleLog`, `memoryState`, `nodeFilesystem`, `nodeStorage`, `nodeWorkspace`, `EnvSecrets`. CLI uses 5 of 6; desktop uses similar set; extension uses none.
- `core/storage/jsonlSessionStore.ts` — Node-fs-backed `SessionStore` impl.

Adding a new Node-based host (e.g. a `texra serve` daemon, or a future Tauri-based app) requires only Ring 3 + a thin host adapter. No Ring 1 or Ring 2 changes.

### 8.2 Per-host packages

Crisp rule: **the host package's `src/` is allowed to import `vscode` / `electron` / `commander` / Ink, and nothing under `core/` is.**

| Host                  | Owns                                                                                                                            | Doesn't own                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/extension/` | `vscode.commands`, webview hosts, `frontend/vscode/*`, controllers wired to webview message handlers, `VscodeOutputChannelSink` | The agent runtime (in core); coordinators (in core) |
| `packages/desktop/`   | Electron `main`, preload bridges, BrowserWindow lifecycle, `electronLogSink`, packaging                                         | Same                                                |
| `packages/cli/`       | `commander` parsing, Ink TUI, `texra mcp serve`, `StderrTextSink`, `NdjsonStdoutSink`, hook command-runner                      | Same                                                |

### 8.3 ESLint enforcement

A flat-config rule that the host of each package can import only the rings it cares about:

- `packages/core/src/agent/**` may import `core/agent/**`, `core/model/**`, `core/latex/**`, `core/eventBus/**`, `core/tools/**` (excluding `tools/approval/**`), `core/shared/**`.
- `packages/core/src/runtime/**` may additionally import Ring 1.
- `packages/core/src/platform/defaults/**` may additionally import `node:*` modules.
- `packages/{extension,desktop,cli}/src/**` may import `core/**` and the host's own SDK.
- Cross-package host imports (e.g., extension importing from desktop) are forbidden.

~40 LOC of ESLint config; mechanical to maintain.

### 8.4 What the refactor saves

- **A new host needs only the rings it cares about.** A future Tauri app: import Rings 1+2 and a Tauri-specific Ring 3 (`tauriFilesystem`, `tauriSecrets`); zero extension or CLI code touched.
- **Tests don't fake hosts to test logic.** Ring 1 has no host. The kernel's existing FakePlatform suite stays in Ring 2 and only exercises Ring 2 code paths.
- **Webview vs CLI vs Electron diff is a wiring diff, not a behavior diff.** When `polish` rewrites a paragraph differently in CLI than extension, we have one place to look (Ring 1 + the agent's YAML), not three.

## 9. Risks & mitigations

| Risk                                                                            | Likelihood | Impact | Mitigation                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ALS context lost across `.then()` boundary (the LangSmith-style foot-gun)       | Medium     | Medium | Phase 5 fixes the one known site (`executionRegistry.ts:335`); ESLint rule + dev review for new timers.                                   |
| Phase 1 coordinator change breaks an in-flight reader site no one tested        | Medium     | Medium | Each coordinator's per-context factory keeps the same observable interface; existing tests catch the regression.                          |
| `RunContext.child()` semantics get wrong (e.g., child's `signal` doesn't chain) | Low        | Medium | Implement child via `AbortSignal.any([parent.signal, childAbort])`; covered by a tabletop test in `runContext.test.ts`.                   |
| Singleton retirement merges before consumers update                             | Low        | High   | Each phase's exit criteria require zero `git grep` hits for the deleted symbols before merge; CI gate.                                    |
| `RunCapabilities` shape drifts as new capabilities are added                    | Medium     | Low    | Add capabilities incrementally; Zod schema validates at construction; ESLint rule forbids reading capabilities outside `useRunContext()`. |
| Test setup churn during migration                                               | Medium     | Low    | `runtime/testing.ts` exposes `synthesizeRunContext({ overrides })` — one call replaces ~5–10 LOC of `beforeEach` setup.                   |
| Three-ring ESLint rule produces noisy false positives                           | Medium     | Low    | Soft-fail mode in CI for the first two weeks; harden after.                                                                               |
| Per-context coordinator instances over-allocate (one set per run)               | Low        | Low    | Coordinators are tiny (Map + a Resolver list); per-run cost is sub-µs. Profiled in tabletop benchmark.                                    |

## 10. Success criteria

- After Phase 5, `git grep "let [a-zA-Z_]*: .* | undefined" packages/core/src/agent packages/core/src/tools packages/core/src/auth packages/core/src/logger | grep -v // | grep -v test` returns only the four §4.4 caches.
- `git grep "AsyncLocalStorage" packages/core/src/` returns exactly one hit (`runContext.ts`).
- `texra mcp serve` integration test (per `2026-05-04-prd-cli-app.md` §30.3) runs two concurrent `tools/call`s and the resulting NDJSON streams contain zero cross-session events when grouped by `runId`.
- `npm run typecheck` and the existing kernel test suite both pass on every phase merge.
- The three-ring ESLint rule has zero exceptions in `packages/core/src/agent/`, `core/tools/`, `core/auth/` after Phase 5.
- A new "synthetic host" package (~80 LOC scaffold, used in tests and as a reference) imports Rings 1+2+3 and runs `executeAgent('polish', …)` end-to-end.

## 11. Decisions

- **`RunContext.workspaceRoot` is a `string`** — derived from `WorkspaceProvider` at context-build time, overridable per-run by the CLI's `--cwd` flag and by per-root invocations from the extension's multi-root workspace.
- **Singleton retirement lands before the kernel package split** — fewer reader sites that depend on module-load order across packages.
- **`ctx.signal` is the canonical run-cancel; modelHandler `signal` params take precedence when explicitly passed.** Today every modelHandler accepts an explicit `signal` parameter from `ExecuteAgentOptions`; the two compose, not collide.

## 12. Open questions

- **Should `RunCapabilities` be open or closed?** Open (free-form `{ [k]: unknown }` plus typed accessors) is more future-proof; closed is type-safer. Lean: closed for v1, open for v2 if external plugins ever ship.
- **Is `child()` enough for delegate semantics, or do we need a dedicated `delegationContext` field?** Today's delegate flow recursively calls `executeAgent` with new options; the recursion is handled at the call site, not in the context. Lean: keep `child()` only; don't add a delegation field until a concrete reader needs it.

## 13. Tech stack one-liner

```
Single AsyncLocalStorage + RunContext threaded explicitly through the kernel call graph
- packages/core/src/runtime/runContext.ts as the only allowed scope
- Phased deletion of 19 module-level setter pairs and 3 singleton coordinators
- Three concentric rings under packages/core/ (pure logic / runtime / platform defaults)
- ESLint rule no-ambient-runtime-state guards the agnostic zones
- Independently mergeable phases; CLI v1.0 consumes Phase 1, v1.1 consumes Phase 2
```

The kernel stays small. The rules stay simple. Concurrent runs stop leaking into each other. That's the whole story.

## 14. Single source of truth and abstraction budget

`RunContext` is the single source of truth for one execution's runtime facts: stream identity, execution identity, logger, runtime host, approval coordinators, cancellation signal, working directory, and host capabilities. Tool-call-local facts must stay in the tool call context, not in `RunContext`; host presentation facts must stay in the host package.

The purpose of this refactor is to reduce ambient state, not to replace global state with a chain of forwarding objects. A new context field, accessor, or coordinator is acceptable only if it owns a real invariant: lifetime, identity, cancellation, approval settlement, or host capability selection. Accessors that merely relay data without clarifying ownership should be removed.

PRs for this PRD must state:

- Which runtime fact moved into `RunContext`, and why that is the correct owner.
- Which singleton or duplicated host-specific path was removed or scheduled for removal.
- Host impact for extension, desktop, and CLI.
- Any abstraction added, with the invariant it enforces.
