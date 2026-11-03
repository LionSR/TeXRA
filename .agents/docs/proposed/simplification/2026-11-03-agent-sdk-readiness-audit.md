---
created: 2026-11-03
status: proposed
---

# Agent SDK readiness: audit confirmation and the open edges

A read-only pass over the four areas named in the request — the agent core,
the model handler, the logger, and the public surface — asking the standard
SDK-readiness questions: which abstractions earn their place, where the
surface is wider than it needs to be, and where the natural subagent
boundaries lie.

## Conclusion first

The codebase is already aligned, and SDK readiness is not a greenfield audit
here: it is a **live, owner-sequenced program** with its own authoritative
designs, measured baselines, and PRs landing within the last week. The
"unnecessary abstraction" hunt this request describes has already been run
exhaustively — seven read-only audits, a four-design adversarial comparison,
and a standing `refuted-candidates.json` ledger — and the surviving
abstractions were kept deliberately, with recorded reasons.

The owning notes, which this memo does not restate or replace:

- [`2026-10-21-harness-general-package-design.md`](../architecture/2026-10-21-harness-general-package-design.md)
  — the surface, the ports, the plugin/subagent contract, the deletion ledger,
  the nine lanes, and two dated re-checks.
- [`2026-10-27-tech-debt-target-designs.md`](../architecture/2026-10-27-tech-debt-target-designs.md)
  — the ten costliest debts as Effect-native target designs and PR slices.
- [`2026-10-28-harness-1-release-prd.md`](../architecture/2026-10-28-harness-1-release-prd.md)
  — the 1.0 surface rulings.
- `config/ratchets/refuted-candidates.json` — refactors investigated and
  refused.

The rest of this note records what was verified first-hand against the current
tree, so the program's progress is legible, and names the edges that are still
genuinely open.

## The four areas, verified against the current tree

### Agent core (`packages/harness/src/agent/`)

`core/` is the domain model (`definition/`, `tools/`); the runtime is one
Effect program — `runToolUse` (`runtime/loop/`) continuing from the `RunState`
that `RunCell.append` returns, so live and resume are one function. There is no
flow engine, no cursor, no services bag: services come from context at the
`executeAgent` boundary. This is the opposite of an over-abstracted core; the
AGENTS.md and the one-run-model note (`implemented/architecture/2026-09-10-one-run-model.md`)
freeze it against a second writer or a second append path. No abstraction to
remove here.

### Model handler (`runtime/ModelInvoker.ts` + `runtime/modelAccess/`)

`ModelInvoker` (799 lines) is the single caller of the `packages/llm` `Model`,
and the one retry loop lives in `run/invocation.ts`. `modelAccess/` routes by
**data**, generic over `ApiKeyProviderId` (`ModelAccess.ts`, `binding.ts`,
`credentials.ts`, `routeDecision.ts`), so a new provider is a data row, not a
handler class — the "new provider is data, not a handler" rule in the harness
AGENTS.md. #14565 (`embedders supply the model transport as ModelFetch`) just
turned the transport into an embedder-supplied port, which is the SDK-facing
move this area needed. The handler is already a deep module over a data-driven
router; the only size signal is `ModelInvoker` at 799 lines, which is behavior,
not indirection (budgets, retry-decision rows, partial-text handling).

### Logger (`packages/harness/src/logger/`)

Five small files, ~516 lines total: `logSink.ts` (the one host diagnostic
port — one structured entry in, one host surface out; redaction at the single
owner), `effectLog.ts` (the channel), `redaction.ts`, `formatLogData.ts`,
`effectDiagnostics.ts`. Read first-hand: `logSink.ts` is a textbook deep module
— severity/timestamp/identity/payload stay separate fields the whole way, a
host renders with its own facilities, secrets are redacted once before any host
sees them. No wrapper layer, no indirection to collapse.

### Public surface (`packages/harness/src/effect/`)

The SDK door: `Sessions`/`processLayer` plus the `Session`/`Run`/`LocalSession`
interfaces in `sessions.ts`. Measured now: the root entry exports **57** names,
down from 246 at the audit baseline (the design targets ~30; an interim
re-check recorded 48). `Run` deliberately exposes `result`, `view`, `events`,
`interrupt` and **not** `followUp`/`stop`/`decide`/`transcript` — the
2026-10-28 PRD rejected methods on `Run`/`Session` that only forward to
`session.request`, which stays the one door. That is the no-pass-through rule
applied to the surface itself; adding "SDK convenience methods" here would
re-tread explicitly rejected ground.

## The abstraction hunt is already recorded — do not re-tread

`refuted-candidates.json` holds 14 investigated-and-refused simplifications,
each with a reason. Re-proposing any of these without new evidence is wasted
work (and the ledger rule requires rewriting the entry in the same PR if new
evidence overturns one):

- Effect-adoption swaps refused as already-covered or worse: config provider,
  per-key-lane→semaphore, retry-gate→`Schedule`, retry-gate→circuit-breaker,
  timeouts, jitter helper, MCP client.
- Runtime lifts refused: execute-command lift, install-CLI process runtime,
  desktop PTY host.
- Surface consolidations refused: external-roots standalone service, the llm
  subscription-credential facade, and **merging the two view services**
  (`SESSION-one-view-service`; re-affirmed by #14559, which refuses merging
  `sessionViewUpdate`).

The general-package design's own writer-near-miss re-check (2026-10-21) found
all five candidate second-writers to be distinct rules, not duplication.

## Subagent boundaries are already designed

The request's "identify logical units that could run as independent agents" is
answered by the existing model, not open:

- **Plugins** are the unit (`Plugin`, `definePlugin`, `defineTool`); the
  authoring closure is the `./plugins` subpath. A plugin may own one agent
  block (`Plugin.agentBlock`); the documents plugin's `task:` block makes an
  agent a document task.
- **Child runs / delegation** already run logical units as independent agents:
  `nativeSubagentStrategy`, `ChildRuns.launchProcess`, and the delegation
  launch (`packages/harness/src/agent/runtime/delegation/subagentRun.ts`),
  each child a first-class run with
  its own trace and budget permit (`child-run-concurrency-budget` note). #14566
  just made a goal's strategy a typed module with a typed result.
- **Deferred tools** (`defineTool({ deferred: true })`) are the discovery
  boundary for large tool sets, building on codemode.
- The **`builtins/` fence** (lane 4b) is the planned boundary that forces every
  built-in to be writable on the public surface; the app's own count of
  built-ins needing internals is already zero.

## Genuinely open edges (owner-sequenced; most freeze-gated)

These are the owner's own lane items, not new findings — listed so the program
state is legible:

1. **Lane 1 leftovers:** `effect/` → `sdk/` rename; shrink the root from 57
   toward ~30 by narrowing run-lifecycle signatures (the 1.0 PRD work), not by
   deleting consumed names.
2. **Freeze-gated row changes** (must precede `storage:freeze`): D4, pasted
   media stored by blob digest; D5, rename the one out-of-namespace key
   `polishModel` → `helperModel`.
3. **Host dedup (lane 7):** `desktopHostRequests.ts`/`extensionHostRequests.ts`
   share ~400 lines; ~1,400 lines of host composition can go via
   `createGuiHostRequests` and one service reach.
4. **llm lowering duplication:** ~350 lines duplicated across the Responses/
   Anthropic/Google adapters in `packages/llm/src/api/`.
5. **Four CLAUDE.md rules with no check:** the barrel ban, the single-caller-
   extraction ban, renderer `Date.now()`, and silent degradation outside the
   harness/llm cores. Turning these into ratchets is the highest-leverage
   *small* cleanup, since the structural work is already enforced by ratchets
   and the gaps are the unchecked rules.

## Why no code changed in this pass

This is owner-sequenced, in-flight work: the session merge collides with the
two most-edited files (`runRegistry.ts`, `SessionEvents.ts`), several items are
gated on the storage freeze, and PRs touching exactly these areas are landing
continuously (#14588, #14565, #14566, #14559, #14550 in the last window). An
autonomous refactor would collide with the owner's lane order and the freeze
gating. The repo's norm — and the right move here — is proposal-first, so this
pass confirms alignment and points at the authoritative designs rather than
editing the tree.

## Verified

- `main` (branch `claude/eager-noether-junwy5`) at the current HEAD.
- Root export count: `config/api-reports/harness.api.md` header, "Exports: 57".
- Area line counts: `ModelInvoker.ts` 799; `modelAccess/*` 242/218/215/74/227;
  `logger/*` 77/24/118/179/118; `effect/*` 70/244/231/130/281/267/292.
- Read first-hand: `logger/logSink.ts`, `effect/sessions.ts`,
  `packages/harness/AGENTS.md`, and the three owning design notes.
- `refuted-candidates.json`: 14 entries, ids listed above.
- Not run: any build or test (read-only pass).
