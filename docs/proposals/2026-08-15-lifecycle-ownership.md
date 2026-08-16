# Lifecycle ownership: five roots, one idiom (2026-08-15)

> **Status:** Adjudicated audit + design, 2026-08-15, pinned to origin/main
> `3122ace2bc`. Fourth doc of the consolidation set (companions:
> `2026-08-15-cross-host-consolidation.md`,
> `2026-08-15-single-substrate-hosts-as-renderers.md`,
> `2026-08-15-shared-contracts-and-retirement.md`). Produced by two
> multi-agent workflows (14 agents): four lifecycle domain sweeps
> (boot/shutdown per host, session/execution/stream, leak hunt, disposal
> idioms), an industry-patterns survey, a delegation/child-work ownership
> sweep, a background-task/OS-process sweep — every load-bearing claim
> adversarially re-verified, with three finder claims refuted or narrowed
> and carried here in corrected form.
>
> **Review round applied (2026-08-16):** recording re-rooted to
> view/window scope, lease settlement moved to an awaited shutdown drain,
> the shutdown deadline extended to an abort-then-advance contract, the
> SDK's deliberate run-scoped cleanup recorded as a process-root
> exception, and the §6 step-9 wording aligned with §4's no-table rework.

## 0. The verdict, at two altitudes

The maintainer's "very ad hoc" impression is right and wrong at different
altitudes, and the design spends its budget accordingly:

- **Resource ownership is mostly sound.** Three strong patterns cover ~40
  audited resources: the lease protocol (process-wide heartbeat, fenced
  writes, cross-host adoption), the child-run loop's run-scoped unwind
  (the tightest lifecycle in the codebase), and `StreamLogStore` residency.
  Only three never-migrated process-global singletons leak in practice.
- **Idiom multiplicity and quit-path choreography are the genuine mess.**
  The census found **8 coexisting teardown idioms** (~47 sync `dispose()`
  declarations, ~101 unsubscribe closures, 8 async dispose sites, 146
  try/finally sites, hand-rolled disposer arrays, comment-enforced ordering,
  generation counters, `lifecycle.onShutdown`) and **12 real collision
  points** — plus a per-host stop/quit policy layer for child work that
  makes the same user gesture mean three different things (§4).

## 1. The target lifetime model — five roots, all pre-existing

Every owned resource registers with **exactly one** root's store at
creation; ownership moves only by explicit transfer (`move()`), never
aliasing. The roots are anchors that already exist (R4: nothing new):

| Root             | Anchor (exists today)                 | Closes via                                |
| ---------------- | ------------------------------------- | ----------------------------------------- |
| Process/platform | `LifecycleHost` + one process store   | `runShutdown()` (idempotent, phased)      |
| Session          | `SessionHandle`                       | `dispose()` → store dispose (LIFO)        |
| Execution/run    | `AgentExecutionHandle` + lease scope  | `finalizeRunTerminal` (claim-gated)       |
| Stream           | `StreamLogStore` residency record     | residency-lease release                   |
| View             | webview/window/TUI-generation context | unmount / context death / generation bump |

The full resource→root assignment table (every audited resource, exactly
one root, with today-vs-change per row) is in the workflow synthesis; the
rows that change:

- **Process root:** GitHub polling singletons get `unref()` + self-registered
  `disposeAll` (today extension-only teardown); Lean server disposal
  consolidates from three-owners-in-three-modules (plus the extension's
  hand-called fourth path) to one registration; `UsageLogService` loses its
  dual registration.
- **Session root:** `SessionHandle`'s ctor-ordered owners move into a store
  (deleting the comment-enforced disposal sequence and hand-rolled failure
  aggregation at `SessionHandle.ts:1073-1107`); `ToolUseFollowUpQueue`
  gains the manager-level `dispose()` it lacks; **owned execution leases
  become a session-dispose settlement obligation** (§3 fix 2 — the
  widest-impact fix); the `CodexThreads`/`ClaudeAgentSessions` module
  registries move to session keying (the `childRunBudget` WeakMap model —
  the last instances of the #7694-banned pattern).
- **Execution root:** the childRunLoop's ordered `finally` ladder becomes a
  run-scoped stack so ordering is structural. _(Recording re-rooted on
  review: recordings start from the main/progress view with NO agent
  execution in existence, so run-scoping would tie them to an unrelated
  run or nothing — the recorder is a **view/window-root** resource with a
  self-registered process-shutdown backstop, scoped to the two
  recording-capable hosts.)_
- **View root:** presentation leases get a store backstop (7 hand-released
  sites today); the CLI's one-shot `disposers` array and the extension's
  provider/view disposable arrays migrate onto it. TUI `RESET_HOOKS` stay
  repeatable unless a scope-remount deletion is proven; they are not one-shot
  disposables.

Cross-root edges stay as the two existing verbs
(`deleteStreamAfterOwnedExecutionRelease`, `detachActiveChildren`); the
duplicated stream→execution three-tier resolver collapses to one.

## 2. The one disposal idiom (industry-grounded)

**Decision: sync `dispose(): void` with `[Symbol.dispose]` as an alias,
composed by a ~60-line house `DisposableStore` in `src/platform/`;
`using`/`await using` at function/test scope; AbortSignal as the only
cancellation channel; async drain kept separate on `lifecycle.onShutdown`
with join-with-deadline.**

Grounds (evidence over fashion):

- The census is lopsided: ~150 sites already on the sync-dispose /
  unsubscribe-closure shapes vs 8 async dispose sites; the canonical shape
  exists at `src/platform/interfaces.ts:17` and is VS Code-compatible.
  Async-first would migrate 8 sites toward and ~150 away, and collides
  with the extension's ~5s deactivate budget — the sync-dispose/async-drain
  split is precisely why VS Code standardized this way. `Symbol.dispose`
  is native since Node 20.4; TS6 downlevels `using` on our ES2022 floor.
- Store semantics: idempotent LIFO, isolated child failures aggregated with
  `throwAggregated`, and **immediate add-after-disposed**. `move()` and global
  leak assertions stay deferred until a consumer deletes an existing mechanism
  in the same PR; the store does not speculate those surfaces into existence.
- Cancellation: `{signal}` threading stays; mechanical upgrades only
  (`AbortSignal.any`, `AbortSignal.timeout`, `throwIfAborted()`); the
  existing `onAbort` bridge remains the sanctioned signal→disposer adapter.
- Drain: `lifecycle.onShutdown` keeps its architecture and gains a
  per-phase bound with laggard logging — verified: **zero unconditional
  drain timeouts exist today** on any host (desktop `before-quit` awaits
  unboundedly; the CLI's grace race is bypassed on its recovery branch).
  _(Contract rider from review: a `Promise.race` bound alone does not stop
  the laggard — it keeps running while `runShutdown` advances, and a late
  BEFORE handler can then race the ON phase's disposals. The deadline
  therefore extends the drain contract: handlers receive an abort signal
  fired at the deadline, and a phase does not advance past an un-settled
  laggard without first aborting it.)_

Migration is ranked by collision severity (sync/async seam and its
`void`-casts first; the CLI's triple exit system second; lease-as-fourth-
system third; SessionHandle choreography fourth; desktop's 8-step manual
window ledger fifth). **No mass migration** of the 146 try/finally or ~101
closure sites — stores in new and touched code only.

## 3. Leak fixes, by user impact (all verified; corrections carried)

1. **Polling interval**: `unref()` + self-register `disposeAll` at the
   process root in `PollingSourceBase` itself (deleting the extension-only
   registrations). Impact: headless `texra run` hangs at natural exit — in
   residual windows only (the run-end subscription reaper handles normal
   completions; the "unconditional hang" claim was downgraded on verify);
   desktop polls GitHub until process death.
2. **Quit-time lease settlement at the session root** — as an **awaited
   session-owned shutdown drain, not `dispose()`** _(mechanism corrected on
   review: `completeOwnedExecutionLease` is async under cross-process file
   locking, and the sync `abandonOwnedExecutionLease` deliberately leaves
   the persisted lease until the stale horizon — so settlement inside a
   sync `dispose()` cannot fix the resume-block window; it runs as a drain
   the shutdown registry awaits, before synchronous disposal)_. Verified as
   a **four-host gap of varying width**, not "CLI is fine":
   extension/desktop never settle (blocks resume up to the 120s horizon);
   CLI TUI settles only when `isResumableIdle()`; headless can lose its
   grace race. Deletes the CLI-UI-layer settlement as the sole
   implementation.
3. **Desktop recording kill** — view/window-scope the recorder (per the §1 correction); interim, register
   the kill in desktop shutdown. (Corrected on verify: sox does not orphan
   on graceful desktop quit — execa's cleanup default covers it; the
   exposure is abrupt kill, same as the extension's. The CLI claim was
   refuted: no audio path exists there.)
4. **Join-with-deadline on `runShutdown`** — today any hung BEFORE handler
   wedges desktop quit / eats the deactivate budget / wedges CLI SIGTERM.
5. **Extension activation-failure catch → `runShutdown`** (desktop already
   does this): an `activate()` throw between session init and shutdown
   registration currently drops the session un-flushed.
6. **`followUps` disposal at session teardown** (no manager dispose exists).
7. **Desktop `resolveEmitSession` silent skip** — ruled a design decision to
   make, not a leak: either desktop installs a default session or the
   fallback logs at warn (silent-degradation rule).

Non-fixes recorded so they aren't re-reported: lease heartbeat (correct),
idle OpenAI WS (deliberate), detached-group crash orphan (documented
tradeoff), `inlineAgents` (deliberate, name-bounded — but delete or wire
its dormant `clearInlineAgents` export), desktop UsageLogService absence
(product gap, tracked as V2 in the audit doc).

## 4. Child work: subagents, background tasks, bash — the consistency matrix

Second workflow, separately verified. The substrate is **consistent by
construction**: one driver (`childRunLoop`) for all four child types
(native detached, in-band/grandchild, workflow-script, agent-CLI), one
lease protocol with three-layer double-ownership defense and working
cross-host orphan adoption, host-invariant terminal persistence and
parent-wake-after-finalize ordering, `registerAgentShutdownHandlers` wired
identically in all three hosts (+ the SDK host — with the review-recorded
exception that SDK embedders never run host shutdown handlers, so
`packages/agent` deliberately performs that cleanup **per run** in its
`runAgent` `finally`; the migration must keep that run-scoped path, not
re-root it at a process lifecycle no embedder calls), bash fore/background and
codex/claude process kill paths uniform, crash-swept process rows uniform.

**The ad-hoc layer is stop/quit _policy_** — which events consult the
detach SSOT and what quitting means for children:

| Event                      | extension                         | desktop             | CLI                                                                                                  |
| -------------------------- | --------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| user stop (active)         | detach toggle                     | detach toggle       | detach toggle                                                                                        |
| stop specific stream       | toggle                            | toggle              | **hardcoded detach** (`stopStream`) — deliberate: focused Escape always detaches descendants (#9009) |
| headless shutdown          | —                                 | —                   | **explicit cascade-kill** (`kill` with `{detachActiveChildren: false}`)                              |
| host quit, native children | abandon → repair                  | abandon → repair    | headless: kill+await; TUI: interrupt on ^C, abandon on ^C^C                                          |
| host quit, foreground bash | orphans (deliberate resume-first) | orphans             | **killed** on normal quit gestures (verifier-caught asymmetry)                                       |
| toggle backing store       | Memento (worktree-shared)         | shared `state.json` | same `state.json`; **no CLI surface to set either toggle**                                           |
| detached-child approvals   | always-attached UI                | always-attached UI  | explicit `interactionOwnership` (sole writer)                                                        |

**The fix — no new concept.** The SSOT already exists
(`detachSubagentsOnStop()`); a policy-event table beside it would be an
invented concept wearing a consolidation costume (the reward-hack the
maintainer flagged: "cleaner" by adding vocabulary). The actual fix is
two headless call-site repairs and one sentence of documentation:

1. The two optionless headless `kill` sites pass an explicit
   `{detachActiveChildren: false}` with a comment stating headless
   shutdown deliberately cascades — the behavior is probably correct;
   what's wrong is that it's an _accident of a default_ instead of a
   written decision.
2. The quit asymmetry (GUI abandon-to-repair vs CLI kill) gets one
   paragraph at `detachSubagentsOnStop`'s declaration — the existing
   documentation home — not a new contract object.

Toggle-store unification is owned by the settings-catalog work (contracts
doc §2.1), with a **maintainer ruling recorded 2026-08-15**: the extension
is happy to change — its policy toggles (`DETACH_SUBAGENTS_ON_STOP`,
`ALLOW_ORCHESTRATOR_KILL`) move onto the shared `~/.texra` state store the
other two hosts already agree on, rather than the shared path bending to
the Memento. `interactionOwnership` needs one ruling: promote to the
shared registry contract or fence as CLI modality.

Also verified in this sweep: **LaTeX compiles are uniformly signal-less**
(`compileLatex2Pdf`/latexdiff take timeout only; the `executeCommand`
substrate supports `signal` but no caller threads it — a user stop never
kills an in-flight compile on any host). Thread `runScope.signal` through
the four call sites; this is the one place the cancellation spine simply
wasn't connected.

## 5. Industry patterns: adopted / rejected

Adopted (all native or in-tree): the VS Code Disposable model (one sync
shape + store + leak-assert), TC39 explicit resource management (`using`,
`Symbol.dispose`; native `DisposableStack` deferred to a Node 24 floor —
house store until then), AbortSignal structured cancellation
(`any`/`timeout`/`throwIfAborted`), the sync-dispose/async-drain split,
structured concurrency as a _rule_ (scope owns children; `SessionHandle`
and `childRunLoop` already are this), `p-queue`'s
`abort → clear() → race(onIdle, timeout)` as the drain primitive, `execa`
signal threading (bash already does it).

Rejected by name: DI containers (maintainer ruling — lifecycle ≠ DI),
Effection v3 (generator-viral) and Effect-TS (whole-program buy-in; no
production-dominant SC library exists), any new bus/plane/shutdown
coordinator (R4), the `disposablestack` ponyfill and core-js shim (60-line
house store wins), asyncifying `dispose()` (the exact mistake the VS Code
split avoids), `signal-exit` (Ink already embeds it; keep one exit matrix).

## 6. Staged plan — each PR net-deletes an ad-hoc mechanism

1. **Leak triage** (no new machinery): polling unref + self-registration;
   recording backstop. Deletes the extension-only registrations.
2. **`DisposableStore` + focused lifecycle coverage** replaces the CLI session
   `disposers` array, execution-interaction detachers, and the extension's
   provider/view disposable arrays. `RESET_HOOKS` stay repeatable.
3. **Session-root consolidation**: ctor-into-store; `followUps.dispose()`;
   `teardownOwners` = one line. Deletes the comment-enforced order.
4. **Lease settlement at the session root** (after 3). Deletes the CLI-UI
   settlement as sole implementation; fixes the four-host resume-block gap.
5. **Join-with-deadline + extension activation catch.** Deletes the bespoke
   CLI grace race and the dual UsageLogService registration.
6. **Async-dispose split** (8 sites). Deletes the `void`-casts and the
   promise-smuggled shutdown callback.
7. **Desktop window root.** Deletes the 8-step manual ledger and the
   `pendingDesktopDiffHostDispose` module hand-off.
8. **Tool-layer singletons → true scope** (agent-CLI registries session-
   keyed; recording view/window-scoped; delete-or-wire `clearInlineAgents`;
   collapse the duplicated stream→execution resolver).
9. **The §4 stop/quit call-site repairs (no table — §4's rework is the
   spec: explicit documented options at the two shutdown sites, one doc
   paragraph at the SSOT declaration) + LaTeX
   signal threading + `using` adoption in tests/new scopes + Lean
   single-owner registration.**

PRs 1–5 independent except 4-after-3; 6–9 ride on 2. Every step leaves the
tree with strictly fewer teardown mechanisms than it found.

## 7. Honest notes

Verifier corrections carried into this doc rather than the finders' claims:
the CLI recording leak was refuted (unreachable); the headless hang was
narrowed to residual windows (the run-end reaper works); "CLI is the only
host that settles leases" was narrowed twice into the four-host framing;
desktop sox downgraded to "no explicit teardown, execa default covers
graceful quit". One stale doc comment found in passing:
`SessionHandle.ts:142` names a "process-output poller" that does not exist.
