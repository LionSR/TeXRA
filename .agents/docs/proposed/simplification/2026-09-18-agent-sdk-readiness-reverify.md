# Agent-SDK readiness — re-verification pass (2026-09-18)

Status: implemented

> **Status:** Written 2026-09-18 against branch HEAD `5616aed`
> (`refactor(config): getConfig and readConfig take explicit stores`, #12761).
> The scheduled audit routine re-ran the standing question — "review the agent
> core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the most recent prior
> pass ([`-09-04`](../../archived/simplification/2026-09-04-agent-sdk-readiness-reverify.md),
> whose inspected snapshot was `4579625`). That snapshot is **not present in
> this checkout's history** (the clone's `main` does not carry it), so this pass
> does **not** diff the interval commit-by-commit; instead it **re-derived every
> tracked fact from fresh direct inspection at `5616aed`** and cites a
> `file:line`, config path, or count for each. Top-line verdict: **the alignment
> holds — and has materially advanced.** The interval since `-09-04` spans a
> large Effect-4 runtime-migration campaign that *removed* two of the biggest
> structures prior passes tracked. This pass is **recorded, not acted on**,
> consistent with the routine's standing default (no maintainer request
> accompanies a scheduled firing).

## 0. Verdict

**The standing verdict holds and strengthens: the codebase is well-aligned with
an Agent-SDK shape, and no structural refactor is warranted.** This is the
**ninth** green top-line pass in the lineage. What is new since `-09-04` is that
the campaign has not merely held the line — it has *shrunk* the surface the
standing question hunts:

- **The node flow engine is gone.** `src/agent/node/` no longer exists (the
  158-LoC `BaseNode` + `Flow` module every prior pass tracked). CLAUDE.md's
  "There is no flow engine" is now literally true of the tree, not just the run
  loop. `grep -rn 'class BaseNode\|class Flow\b' src/agent packages` returns
  zero.
- **The `ModelHandler` god-base is dissolved.** The 2,026-LoC `ModelHandler.ts`
  (tracked as "M-3") and the hand-maintained `IModelHandler`
  `Pick<ModelHandler<…>>` (a carried-forward open item) **no longer exist** —
  zero references anywhere under `src/`/`packages/`. Provider access now runs
  through `packages/llm` (`bindModel` → `PROTOCOL_BY_KEY` → `constructModel`)
  bound by `src/agent/runtime/run/modelBinding.ts` (1,044 LoC) and called by the
  one `src/agent/runtime/ModelInvoker.ts` (1,323 LoC). The former "M-3 god-base"
  concern retires with the file.
- **`createRunScope` — the one tracked survivor factory — is inlined.**
  `grep -rn 'createRunScope' src packages` returns **zero** hits (was 1
  production caller + 12 test-kernel sites at `-09-04`). The single-caller-factory
  category the standing question tracks is now **empty**.
- **The frozen host→`@agent` deep-import baselines *shrank* on three of four
  packages** (§3): cli 7→**5**, desktop 5→**4**, extension 9→**7**; `agent` held
  at **7**. The ratchet's own charter — "removing a deep import … is welcome and
  should shrink this file" — is being met, not merely held.
- **The SDK shipped `0.41.0`** (`packages/agent/package.json`), up from
  `0.40.9`. Surface-documented advance, not a widening.

No pass-through wrapper or convenience barrel the standing question hunts is
present in the core loop or the SDK. The three area audits run for this pass
(agent core, model handler, logger) each returned an independent **STRONG /
well-aligned** verdict. The only concrete removal candidates found are marginal
single-caller helpers (§4), recorded below and, per the routine default, **not
acted on**.

## 1. Interval character — dominated by Effect-migration refactor and deletion

The exact prior snapshot `4579625` is absent from this checkout, so no
interval diffstat is computed. The **recent history** is characterized instead:
of the last 60 commits (`git log --format='%s' -60`, prefix-bucketed) —
**41 `refactor`, 3 `docs`, 3 `consolidate`, 1 `test`, 1 `dedupe`, 1 `ci`** —
overwhelmingly refactor and deletion, the standing trend. **23 of those 60**
touch `src/agent/**`. The visible subjects are the Effect-4 runtime migration
(`.agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md`):
threading the `ManagedRuntime` from each composition root and deleting the
global slot (#12738), moving `AbsoluteFS` consumers onto Effect `FileSystem`
and deleting the FS statics (#12737, #12742, #12744, #12747, #12749, #12754,
#12758), Effect-typed host-interaction / approval / preview planes
(#12734, #12736, #12750), and dead-code deletions (#12735, #12746). No commit
in view adds a new `export class` or `create*` factory to `src/agent/**`; the
work is deletion and Effect-typing, not new indirection.

## 2. Tracked structural facts re-derived at `5616aed`

| Item | Expected (`-09-04` @ `4579625`) | `5616aed` state |
| --- | --- | --- |
| **Node flow engine** | 158 LoC, `BaseNode` + `Flow` | **Removed.** `src/agent/node/` does not exist; zero `class BaseNode`/`class Flow` in `src/agent`/`packages`. |
| **M-3 `ModelHandler.ts` god-base** | 2,026 LoC | **Removed.** Zero `class ModelHandler`/`ModelHandler<` references. Replaced by `ModelInvoker.ts` (1,323) + `run/modelBinding.ts` (1,044) + `packages/llm` (10,483 LoC / 9 files). |
| **`IModelHandler` `Pick<>`** (carried-forward open item) | hand-maintained `Pick<ModelHandler<…>>` | **Removed.** Zero references; the anti-drift-`Pick` concern retires with the base. |
| **`createRunScope` survivor** | 1 production caller @ `AgentLaunchContext.ts:470` | **Inlined.** Zero `createRunScope` hits anywhere. The tracked single-caller-factory category is empty. |
| **Logger `redactSecrets`** (L-3) | single-arg, closed | **Holds.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:58`); no options branch. |
| **Logger `OutputChannelFactoryOptions`** (§8a) | de-exported | **Removed entirely.** Zero references in `src/logger/`. |
| **`ChildRunStrategy` SPI** | `ChildRunStrategy<TTurn>` | `export interface ChildRunStrategy<TTurn, R = never>` (`src/agent/runtime/childRunLoop.ts:158`), `ChildRunPorts` (`:102`). Gained a requirements type param (`R = never`) — Effect-migration refinement, not a widening. |
| **`agentCreator` boundary** | one linear `runAgentCreator`, inline in extension | **Holds, Effect-typed.** `export const runAgentCreator = Effect.fn('runAgentCreator')(…)` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:491`), still the single extension consumer (§3). Still the one correctly-open boundary. |
| **SDK version** | 0.40.9 | **0.41.0** (`packages/agent/package.json`). |

## 3. Frozen host deep-import width — shrank on three of four packages

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers past the `@agent` barrel, per package; the set-based
ratchet fails on both a new edge and stale headroom):

| Package | `-09-04` | `5616aed` | Δ |
| --- | --- | --- | --- |
| cli | 7 | **5** | −2 |
| desktop | 5 | **4** | −1 |
| extension | 9 | **7** | −2 |
| agent (SDK package) | 7 | **7** | 0 |

`agent`'s 7 remains at its realistic floor (the provider-SDK type-leak
constraint carried forward). The three host reductions are the campaign paying
down exactly the coupling this ratchet exists to shrink — the deletions of FS
statics and the global runtime slot removed the deep imports that reached them.
`extension` still holds the one leaf-surface deep import the Tier-1 manifest
tracks: `@agent/implementations/agentCreator/agentCreatorFlow` (§2, the open
`agentCreator` boundary).

## 4. Concrete removal candidates found this pass — all marginal, recorded not acted on

Three independent area audits surfaced the following. Each is real but
low-value; none is a defect; consistent with the routine default they are
**recorded, not edited into the green tree** absent a maintainer request.

- **C1 — `runInLaunchSession` single-file pass-through** (`src/agent/runtime/AgentLaunchContext.ts:191-193`).
  A one-line forward: `return runInSession(ctx.session, fn)`. Exported, with two
  production call sites (`executeAgent.ts:536`, `:696`) plus one test-kernel
  mock. Textbook "single-caller-ish pass-through" — but it supplies a documented,
  readable name for launch-session scoping (`the inScope the run layer hands to
  everything below the launch`). Borderline-keep; the clearest single match in
  the core.
- **C2 — stale `RunScope` README row** (`src/agent/runtime/README.md:19`).
  The module map documents a `RunScope` module ("canonical run identity + owning
  session"), but **no `RunScope` symbol exists** in code (`grep` hits are the
  unrelated `inRunScope` / `RunScoped` / `canUseRunScopedApproval`). Since
  "READMEs are contracts" here, this is a documentation-ratchet miss worth
  deleting so the module map stays source-of-truth. Zero risk, docs-only.
- **M1 — `resolveModelApiKeyProvider` single-caller helper** (`src/model/openRouterRouting.ts:51-59`).
  A 4-line wrapper (`OpenRouter → 'openRouter'; else resolveDirectModelApiKeyProvider`)
  with exactly one importer (`runtimeModelRegistry.ts:279`). The clearest
  literal match for the "single-caller extractions BANNED" guardrail in the
  model layer; inline into its one caller. (`resolveDirectModelApiKeyProvider`
  it delegates to is multi-caller — keep that.)

Lower still (noted, not tracked as candidates): the codex/xai near-mirror
preference/signed-in wrapper modules (logic already collapsed into
`createSubscriptionPreference` / `createSignedInProbe`, 2 callers each — the
factory bar is met; what remains is thin per-provider naming, and merging to a
table would trade greppable clarity for indirection), and `openRouterEndpoint.ts`
as a one-const module (a clean SSOT that avoids an import cycle).

## 5. One genuine SDK-readiness observation (low severity)

**Host vocabulary below the port:** `src/model/copilotRouting.ts:71-80`
hard-codes user-facing "VS Code" / "Settings → Models" strings inside the
host-agnostic (VS Code-free) model layer. A non-VS-Code embedder that wired a
Copilot-style `LanguageModel` port would surface wrong wording. **Severity is
low in practice:** these strings are only reachable when the Copilot
`LanguageModel` capability is installed, which today only the VS Code host does
(`runtimeModelRegistry.discoverCopilotRoutes` returns empty when the capability
is absent). So no shipped host is mis-served. It is nonetheless host vocabulary
in a declared VS Code-free zone — a manifest-design note for when a second host
wires editor models, not a present defect.

**Doc tension (cosmetic):** `packages/agent/README.md:240` lists "logging"
inside the "host port bundle" prose, but the code deliberately keeps logging
*out* of the `Platform` interface — hosts install a `LogSink` via
`logSink.setLogSink` directly (`src/platform/platform.ts:36-38`). Wording, not a
design defect; a one-line README correction would keep the port bundle accurate.

## 6. Subagent boundaries — already a shipped, clean SPI; no new abstraction needed

The strongest part of the readiness story: the seams an Agent-SDK subagent model
needs already exist and are clean. Re-confirmed at HEAD:

- **`runAgent` (high-level) vs `executeAgent` (low-level)** is the canonical
  two-tier boundary — `runAgent` mints the `executionId`, registers the run, and
  takes the lease; `executeAgent` is the already-registered engine (lineage,
  `WAITING` admission, tool-use resume). A subagent host wires at `executeAgent`.
- **Category dispatch = reflection vs tool-use** — `executeAgent` branches on
  `AgentCategory` into two Effect programs over the one run ledger
  (`launchReflectionRun` / `launchToolUseRun`), each providing its own
  `runLayerFor`. Matches "there is no flow engine."
- **`ChildRunStrategy` is a live multi-implementor SPI** (`childRunLoop.ts:158`)
  with four independent production strategies (external-CLI loop, native
  subagent, workflow-script, background shell), driven by `childRunLoop` as the
  single owner of everything a child-run does not vary (follow-up lease, one
  interrupt target, per-turn delivery, terminal finalizer). Not speculative.
- **The `AgentEngine` runtime slot** (`nativeSubagentStrategy.ts`) is a *typed*
  service-locator that severs a genuine registry→delegation→executeAgent import
  cycle — a cycle-breaker, not a factory. Keep.
- **The SDK already exposes the subagent tree** as `Sessions` / `Session` /
  `Run` (`packages/agent/src/effect/sessions.ts`), one session per workspace
  storage root, with descendants auto-subscribed into the fold
  (`RunView.descendantRuns`). This is an embedder-facing subagent surface today.

**`agentCreator` remains the single "logical agent not yet running as one"** — a
lone linear `runAgentCreator`, now Effect-typed but still inline in the
extension host (§2). It stays open **correctly**: closing it is interactive-UI
design work (the approval/`AgentCreatorUI` channel the public `HostInteractions`
deliberately lacks), not a mechanical move.

## 7. Bottom line

Ninth consecutive green top-line pass. Every tracked fact re-derived at
`5616aed`: the node engine is now *gone* (not 158 LoC), the `ModelHandler`
god-base and `IModelHandler` are *dissolved*, `createRunScope` is *inlined*, and
three of four host deep-import baselines *shrank*, while the logger stays clean,
the `ChildRunStrategy` SPI holds (with a benign requirements-param refinement),
and `agentCreator` stays the one correctly-open boundary. The recent history is
overwhelmingly Effect-migration refactor and deletion, with no new core
abstraction added. The only concrete removals in scope are three marginal
single-caller/stale-doc items (§4) plus one low-severity host-vocabulary leak
and one cosmetic README doc tension (§5). Nothing found is a defect; nothing
warrants a speculative edit into the green tree absent a maintainer request,
which this scheduled firing does not carry. **The pass is recorded, not acted
on.**
