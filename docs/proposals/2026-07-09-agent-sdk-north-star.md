# Agent-SDK north star: the runtime as an external (multi)agent SDK

> **Status:** Plan of record (2026-07-09). Records the maintainer decision of
> 2026-07-09: **the agent runtime becomes an external (multi)agent SDK that is
> easy to use from outside; the VS Code extension, desktop app, and CLI become
> its reference examples.** This supersedes the "demote the SDK package"
> posture (#7099) as the _long-term direction_ — while keeping its lesson as a
> standing gate (no package without an already-enforced import boundary).
> Grounded in the 2026-07-09 macroscopic review
> ([`2026-07-09-state-of-the-architecture.md`](./2026-07-09-state-of-the-architecture.md),
> §7 and the sdk-consumability / runtime-endstate / workspace-topology areas —
> every number below was recomputed at HEAD `4b402d75a` by an adversarial
> verifier). Companion to
> [`2026-05-30-agent-sdk-readiness.md`](./2026-05-30-agent-sdk-readiness.md) (the earlier
> surface/packaging analysis, whose never-built lint gate this plan finally
> builds) and the session-runtime program (#6951/#6968).

## 1. Where we already are (measured, better than expected)

The **run API is already SDK-shaped** — the north-star test fails at the
_environment boundary_, not the run surface:

- `runAgent` is 92 LoC; `AgentConfigPayload` requires exactly two fields
  (`agent`, `model`); the `AgentEvent` union (20 arms — recounted at HEAD
  `4363b4089`, post-pin: 3 arms landed after the `4b402d75a` review pin) is a
  clean one-way typed fact stream; `AgentFlowResult` returns typed outcome +
  usage.
- The landed session-runtime surface — `SessionHandle`, `session.events`
  (`SessionEventHub`), `session.interactions` (`HostInteractions`),
  `session.runs`/`session.status` — assessed **~80% consumer-worthy**
  (runtime-endstate TD-2 — qualitative: the run/config/event/result surfaces
  pass the embedder test as-is; the four residue deltas in §2 item 3 are
  the remainder); the remaining deltas are migration residue, all
  finish-the-endgame deletions on the existing surface, none redesign.
- The **empirical SDK surface already exists**: exactly **15 `@agent/*`
  modules are imported by all three hosts** (AgentConfig,
  executionRequests/TaskState, ToolUseFollowUp, AgentDirectorySync, storage,
  trace, and 9 `runtime/` modules including AgentRuntimeHost, HostInteractions,
  SessionHandle, SessionEventHub, StreamStatusService). Stage 5 converged on
  this session-shaped core without anyone declaring it. This intersection is
  the surface _seed_ — derived from use, not designed on paper.

## 2. The friction list (what an outside embedder trips on, ranked)

Verified against a paper embedder: _"load agent X from YAML, run on files
A,B in workspace W with model M, stream events to my handler, approve
tool-edit/bash from my logic, spawn 2 subagents, await the typed result,
resume later."_

1. **The bootstrap incantation** (NS-1, strategic — _the_ SDK tax). Reaching
   `runAgent` requires ~20 deep-path module imports plus **9–10 ordered,
   untyped, post-`initPlatform` global registrations** across 6 modules
   (`packages/cli/src/runtime/initPlatform.ts:204-341`), three welded to a
   packaged `resourcesPath`. None are discoverable from types; the ordering
   trap is documented only in a comment (`runExecution.ts:218-224`). The
   drift is already real: the agent-dir bootstrap left outside `nodeHost.ts`
   has diverged between CLI and desktop (different version-state keys;
   desktop lost the re-entrancy guard) — exactly as `nodeHost.ts`'s own doc
   comment predicted. Reference point: a Claude-Agent-SDK-style consumer does
   this with **1 import**. Empirical tax today: CLI = 1,016 LoC bootstrap +
   1,675 LoC per-run host plumbing.
2. **The per-run ceremony** (NS-3). A 265-LoC ordering-sensitive skeleton
   with 6 paired detaches and nested flush choreography
   (`runExecution.ts:159-265`): snapshot attach, streamLog load/flush, trace
   flush, toast bridge, shutdown status — runtime _persistence bookkeeping_
   that leaks into every host. Only ~3 of the 9 steps express consumer
   intent.
3. **Contract residue on the core quartet** (TD-2). Four deletions, no
   redesign: (a) `HostInteractions` request methods 7/7 optional with
   `Promise|undefined` returns while 6 are runtime-hard-required — convert to
   required (rides micro-audit A2's −300..−450 legacy-fallback deletion);
   (b) 6 of 11 `RuntimeInteractionEventPayloads` arms are phantom emit events
   (never host-emitted) — relocate to CLI-local types (net-neutral relocate,
   −6 arms off the contract); (c) the `'runFact.'` string-prefix protocol
   (dated v0.41) — retire on schedule; (d) status leaves on a **split dual
   rail** (trace `status` arm in-run, session fact out-of-run; 10 production
   apply-sites for one fact) — complete atomically per D4's one-paragraph
   trace-arm ruling.
4. **Definitions are never public values** (NS-4). "Load agent X from a
   YAML" resolves only through the disk-directory registry scan. The
   embedding answer already exists — inject `AgentDirectoriesPort` (skips
   bundle and bootstrap entirely; `RemoteAgentLoader` proves the
   parsed-values template internally) — but it is undocumented. Decision:
   document port-injection as the embedding path now (zero code);
   definitions-as-options only when a real external consumer asks.
5. **Vocabulary etymology** (NS-5, accepted-debt). `StreamTabId` as the
   runtime-wide identity type (229 files, 1,593 occurrences, single-sourced
   in `@shared/schemas`) — alias at the package boundary when one exists; a
   repo-wide rename is the maximal-churn class and is banned (R4).

## 3. The boundary is eroding while unfenced (why Step 0 is now)

- Host deep-import surface (`@agent/*` distinct specifiers): extension 49,
  CLI 35, desktop 27 (union 62), up from 36/18/17 on 2026-06-01 —
  **1.36×/1.94×/1.59× in 5.4 weeks, ~2.5 new deep entry points per host per
  week**, each a future SDK-surface migration site (MONO-1).
- Enforcement census: **one** boundary rule in the whole repo
  (`no-vscode-import-in-free-zones`) + one vscode-only vitest. The lint gate
  that #7099's demote decision assumed ("the deferred no-restricted-imports
  gate", `2026-05-30-agent-sdk-readiness.md:148`) **was never built**.
- The inbound direction is clean today — core→host alias violations in
  production: **0** — which means the ratchet installs at a genuinely zero
  baseline, free.

## 4. The sequenced path (each step gated; no step skips its gate)

**Step 0 — Enforcement ratchets (now; no preconditions; config-only).**
R-a: forbid `src/**` (except `src/test-kernel/**`) from importing the 9
extension-homed aliases + `@cli/*`/`@desktop/*` — one `no-restricted-imports`
block + ~30 lines in `dependencyDirection.vitest.ts`; zero violations to fix.
R-b (armed now, executed at the Stage-5 exit): freeze host deep-import
_width_ with a checked-in per-host baseline list (the repo already runs this
pattern: `config/ratchets/knip-baseline.json`, `check-dead-code-ratchet.mjs`); new deep
specifiers require consciously extending the list.
_Trackers:_ the never-built agent-sdk-readiness lint-gate step; #7152.

**Step 1 — Surface definition (gate: #6968 Sweep 1 merged — Stage-5
interactions/session vocabulary IS the surface).** Execute the TD-2 quartet
(required-methods conversion riding A2's deletion; phantom-arm relocate; D4
atomic status completion; v0.41 prefix retirement). Land the
consumer-contract suite as the **executable surface definition** — one suite,
shared with the Step-2 embedder smoke test, not two. R-b baseline freezes.
_Trackers:_ #6968, #6890 (toolEdit channel), #6982/#6984 (sweeps), the #7636
micro-audit A2/A5/A6 rows. _New decision needed:_ only D4's one-paragraph
trace-arm ruling.

**Step 2 — CLI becomes the canonical example (gate: Step 1's port shape
frozen).** Fold the drifted agent-dir bootstrap into `nodeHost.ts`
(parameterize channel + version-state key; keep the re-entrancy guard); the
skill-sources fold waits on its small desktop-behavior decision. Compress the
per-run ceremony toward a ≤~40-line host run loop by moving
attach/load/flush/toast into `SessionHandle` construction/dispose — host-side
lines _deleted_ per concern (the #7560 train), explicitly **not** a
`runSession()` wrapper. **Acceptance: the embedder smoke test constructs a
working host from documented steps only** (≤~80 lines with zero ordering
sensitivity already satisfies the north star; ~40 is the metric to drive
toward, not a commitment).
_Trackers:_ #6966 Stage 3c persistence bullets; the readiness checkpoint's
runSession row _as the metric, not the wrapper_.

**Step 3 — Packaging (gate: a real external consumer exists AND R-a/R-b have
held).** Only now: the barrel seeded from the (by-then-stable) 15-module
intersection; `packages/extension/resources` moves out **in the same change**
that creates the SDK package; `StreamTabId` aliased at the boundary; the
four-lifetime-tier host-obligation shape published (never a flat options
bag). The #7099 lesson is the standing gate: **no package without the import
gate already enforcing its boundary.**

## 5. What NOT to do (verified traps, do not relitigate)

- **No barrel / no `@texra/core` now** — an unenforced package is imported by
  nobody and rots (#7099, measured); a barrel before Stage 5 lands freezes
  mid-rename vocabulary.
- **No `runSession()` facade / SDK wrapper layer** — the readiness doc's own
  Step-6 rejection stands (the AgentConfigPayload-vs-AgentConfig type wall);
  the ceremony shrinks by _deleting_ host-side bookkeeping into
  `SessionHandle`, not by wrapping it.
- **No new planes/vocabularies/renames** (fewer-elements R4); `StreamTabId`
  renames in particular are the maximal-churn class — alias at the boundary.
- **No dependency-cruiser or new boundary tooling** — the repo's proven
  eslint + vitest + baseline-script ratchet pattern is sufficient and already
  trusted by the swarm.
- **No definitions-as-options API before an external consumer exists** —
  document `AgentDirectoriesPort` injection instead (zero code today).

## 6. Acceptance metrics (how we know each step landed)

| Metric                                       | Today (4b402d75a)          | Step-1 exit           | Step-2 exit                         |
| -------------------------------------------- | -------------------------- | --------------------- | ----------------------------------- |
| Ordered post-init registrations to first run | 9–10, untyped              | unchanged             | ≤3, all inside `nodeHost`           |
| Deep imports for a minimal embedder          | ~20 modules                | frozen (R-b baseline) | ≤ the 15-module intersection        |
| Per-run host ceremony                        | 265 LoC, 6 paired detaches | unchanged             | ≤~80 LoC, zero ordering sensitivity |
| `HostInteractions` required/optional         | 0/7 required               | 6/7 required          | 6/7 required                        |
| Phantom contract arms                        | 6 of 11                    | 0                     | 0                                   |
| Status rails to a projector                  | 2 (split dual rail)        | 1                     | 1                                   |
| Boundary violations (core→host)              | 0 (unfenced)               | 0 (fenced, R-a)       | 0 (fenced)                          |
| Embedder smoke test                          | none                       | contract suite green  | constructs host from docs alone     |
