# Agent-SDK readiness — re-verification pass (2026-09-21)

Status: implemented — findings acted on at maintainer request

> **Written 2026-09-21 by the scheduled audit routine.** It re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the immediately prior filed pass
> ([`-09-17`](../../implemented/simplification/2026-09-17-agent-sdk-readiness-reverify.md),
> the "thirteenth consecutive green") and, new since that pass, the
> [post-refactor architecture survey](../../proposed/architecture/2026-09-20-post-refactor-architecture-survey.md)
> (2026-09-20, umbrella #12880), which now owns the "what is left" enumeration.
> This is the **fourteenth consecutive green pass** (`-08-19` → `-09-21`).
> The audits ran at `7543bdc` (#12912); by the time this note was acted on,
> that entire campaign (#12889, #12899, #12902–#12912) had **merged to `main`**,
> and the branch was rebased onto the latest `main` (`0412f2d8`, #12920), where
> every §1 fact and the §3.1 finding were re-verified before acting. Each
> finding carries a `file:line`, config path, or count.

> **Disposition note.** First filed under the routine's standing default
> ("recorded, not acted on": a scheduled firing carries no maintainer request).
> The maintainer then asked, in session, to refactor from the latest `main` as
> far as possible. That lifts the default. The one net-new item that was a
> concrete, safe, non-colliding change — the §3.1 `CLAUDE.md` accuracy fix — is
> **landed in this PR**. The §3.3 model-layer candidate was re-examined against
> the layering and **withdrawn as a false positive** (see below). The larger
> tracked refactors were deliberately left untouched: they are in flight on
> dedicated branches (`prd/effect-logger-0921d`, `prd/effect-config-0921d`,
> `prd/barrel-split-0921d`, `prd/liveness-interruption-residue-0921d`), and
> duplicating them here would collide. §§0–2 and §4 are unchanged by the act
> request.

## 0. Verdict

**The standing structural verdict holds: the codebase is well-aligned with an
Agent-SDK shape, and no speculative refactor is warranted.** Fourteen
consecutive passes reach the same top-line conclusion. Four independent area
audits (agent core + run loop; model handler + `packages/llm`; logger +
telemetry; the `@texra-ai/agent` package surface + subagent boundaries) each
re-derived the banned-pattern candidates — pass-through wrappers, convenience
barrels, one-impl interfaces, single-caller extractions, re-export shims, silent
degradation — and **each returned "well-aligned," with no exported class,
wrapper layer, or one-implementor interface to remove in the four audited
areas.** Every candidate chased turned out load-bearing and, in most cases,
carried an in-file comment stating why. The ratchets that would reject such an
addition (`host-agent-import-baseline`, `architecture-edges`, `effect-migration`,
`knip-baseline`, `file-size-baseline`) all hold.

What is new this pass is **not the verdict** but a confirmation that the wider
1.0 engine replacement is now in its cleanup tail: the two "live defects found
in passing" the 2026-09-20 survey §6 recorded are **already closed on this tree**
(§2), and the surface audit independently re-derived the Tier-1 manifest's own
open ratification questions rather than anything new (§3.2). The single net-new
item is a documentation-accuracy drift in `CLAUDE.md` (and the same list in
`src/README.md`), not a code defect (§3.1).

The structural verdict is unaffected by the act request that followed (see the
disposition note above): the one concrete, safe, non-colliding item — the §3.1
`CLAUDE.md` accuracy fix — is landed in this PR; the §3.3 candidate is withdrawn
as a false positive; the large tracked refactors are left to their in-flight
branches. None of this touches the run loop, the model stack, the public
surface, or any baseline in the widening direction.

## 1. Per-area re-verification at `7543bdc`

| Area | Re-verified fact |
| --- | --- |
| **Agent core / run loop** | Runs are the run-ledger Effect program continuing from the folded `RunState`; no node flow engine, no `ModelHandler`/`IModelHandler` residue. `runAgent`→`executeAgent` is a real high/low boundary (runId assignment, resume-record reuse, stop-latching vs. the already-registered runner), not a pass-through. `run/` helpers are all multi-caller (`turnText.ts` 4, `estimateInputTokensOrNull` 2, `routeEndpoint`/`validationModel`/`toolResultText` 2–3). The `@texra-ai/agent` surface stays clean; provider-type leakage into the published `.d.ts` is the one watch-item and is already mitigated (`packages/agent/src/index.ts:33` sources `AgentFlowResult` from its defining module, not the `@agent/runtime` barrel) and CI-guarded (`packages/agent/scripts/validate-artifacts.mjs`). |
| **Model handler / `packages/llm`** | Not over-abstracted. The `Model` interface (`packages/llm/src/turn.ts:1996`) is a protocol-only SDK boundary; `ModelInvoker` imports no provider SDK (grep for `@llm/openai\|anthropic\|google\|openrouter\|kimi\|glm` in `ModelInvoker.ts` → nothing). `src/model/` fragmentation is warranted — each small module has 2–11 real callers, none a single-caller extraction. `openaiChat`/`openaiResponses`/`openrouterChat` are genuinely different wire grammars sharing the already-extracted `chatStream` machinery, not copy-paste. The `provider → ModelCompatibilityKey → Protocol` two-hop is deliberate: the key is a **persisted** ledger discriminant (`runFlowState.ts:265`) distinct from the live protocol, so resume reads the same rows. |
| **Logger / telemetry** | One diagnostic authority: `@logger/logSink` is the single sink, with `effectLog` (Effect producers) and `logUtils` (Promise producers) as complementary call shapes over one `LogEntry`/`writeLogEntry`. Redaction is applied at exactly one point on the log path (`logSink.ts:118-120`). CLI presentation output (`packages/cli/src/runtime/logSinks.ts`) and agent trace (`@agent/trace`) are correctly separate concerns, not competing authorities — and `writeRawAndWait`/`NdjsonStdoutSink` are frozen in `refuted-candidates.json`/`knip-baseline.json`, so a prior collapse was already fought and refused. No `catch {}` and no failure-masking `??` in `src/logger/` or `src/telemetry/`; `UsageLogService` is loud on every failure path. |
| **Surface / subagent boundaries** | The published surface (`@texra-ai/agent` root + `/effect` + `/schemas` + `/node`) is coherent and ratchet-guarded. The three surface-minimality observations the audit raised (dead `MapToolRegistry`/`IToolRegistry` on the root entry; the `ToolHost`/`unavailableHosts` product enum reaching external tool authors; `AgentPlatform` requiring `agentResume`/`languageModel` ports `nodePlatform` only stubs) are **exactly the Tier-1 manifest's open ratification questions** (§3.2), not new. |

## 2. The 2026-09-20 survey §6 defects are already closed here

Both "live defects found in passing" the post-refactor survey recorded are gone
on `7543bdc`:

- **`UsageLogService.dispose()` phase inconsistency across host bootstraps** →
  closed. Usage logging is now a scoped Effect layer (`usageLogLayer`,
  `src/telemetry/UsageLogService.ts:568`), whose docstring (`:565`) explicitly
  records the old "`dispose` in a different shutdown phase in each host" hazard
  it replaces. The CLI no longer wires it manually (`initPlatform.ts` carries no
  `UsageLog` reference).
- **`packages/cli/src/commands/tools.ts` empty catch as
  `Effect.orElseSucceed(() => null)`** → gone. `grep orElseSucceed` over
  `packages/cli/src` returns nothing; the silent-degradation site no longer
  exists.

## 3. Findings this pass

### 3.1 (New) `CLAUDE.md` describes a `platform()` capability bundle the code no longer has

`CLAUDE.md:131-132` (the "Separation of concerns: VS Code coupling" section,
which the file itself calls "the highest-signal rule in the repo and the first
thing to check on any diff") reads:

> Reach host services through `platform()` from `@platform/platform` (config,
> state, log, fs, workspace, storage, secrets).

The current `Platform` interface (`src/platform/platform.ts:43-52`) exposes only
`lifecycle`, `agentDirectories`, and an optional `toolMissingHandler` — none of
the seven services named:

- `config`, `state`, `workspace`, `storage` moved to `WorkspaceRoots`, carried
  by each `SessionHandle` (`platform.ts:30-33`), precisely so one process can
  hold sessions rooted in several folders.
- `fs` was removed — the `Platform.fs` port "has zero references" (2026-09-20
  survey §1).
- `log` was never a `Platform` port: "diagnostics are their own subsystem …
  the platform abstraction doesn't carry a log backend" (`platform.ts:39-41`).
  Agnostic code reaches logging through `@logger/logUtils` / `@logger/effectLog`.
- `secrets` is not on `platform()` either.

Why it matters: this is the doc every agent (and the repo's own stated
"autonomous-agent navigability" goal, `2026-09-20-agent-refactorability-gates`)
reads as ground truth for the codebase's central invariant. A stale capability
list here mis-teaches where host services live. This is the same
guidance-vs-code drift class the logger area also surfaced (guidance implying a
`platform().log` port that does not exist).

**Landed in this PR.** The parenthetical now names what `platform()` actually
carries (`lifecycle`, `agentDirectories`, and the optional `toolMissingHandler`)
and routes the rest to its real owner, verbatim from `platform.ts:13-52`:
per-workspace `workspace`/`storage`/`config`/`workspaceState` to the
`WorkspaceRoots` each `SessionHandle` carries; the filesystem, secrets,
application state, resume, and the editor language-model bridge to the
`FileSystem`/`Secrets`/`AppState`/`AgentResume`/`LanguageModel` Effect services
`installProcessRuntime` provides; and diagnostics to the `logSink.setLogSink`
subsystem. The "add a typed port … rather than an import" guidance after it is
kept (re-worded to "at the owning seam"). Re-verified present on latest `main`
(`0412f2d8`) before editing. The same stale list also appeared in
`src/README.md:27` (the `src/platform/` row), corrected in this PR to name the
`Platform` / `WorkspaceRoots` / `installProcessRuntime`-service split; the two
`2026-05-02-prd-electron-app.md` occurrences are archived history and correctly
left frozen. `AGENTS.md` was already accurate (it states "there is no
`platform().config`", `AGENTS.md:573`).

### 3.2 (Not new) The surface audit re-derived the Tier-1 manifest's open ratification questions

The three surface-minimality observations map onto the manifest of record
(`2026-09-10-agent-sdk-tier-1-manifest.md`), which enumerates every published
symbol and lists its keep-or-seal decision as the **open ratification work**
CLAUDE.md names ("the open work is the Tier-1 public manifest and shrinking the
frozen lists"):

- `MapToolRegistry` / `IToolRegistry` on the root entry — manifest §3.1 rows
  148, 160. No public input accepts a registry today (`RunAgentInput.tools` and
  `StartInput.tools` are both `readonly ITool[]`); whether the SDK's tool
  surface keeps or seals these is a ratification question.
- `ToolHost` / `unavailableHosts` reaching external tool authors — manifest §3.1
  row 161. Same class: an internal product taxonomy the "frozen, not open"
  surface should decide to keep or internalize.
- `AgentPlatform` requiring `agentResume`/`languageModel` that `nodePlatform`
  stubs — manifest §7 item 4, "`AgentPlatform extends Platform` roots coupling …
  Still live, still open."

These are confirmation that the manifest's open half (its "what Tier-1 keeps or
seals" decisions) is still the right next design step, not new findings.

### 3.3 (Withdrawn — false positive) `src/model/openRouterEndpoint.ts`

The model-area audit flagged this one-line module (`export const
OPENROUTER_BASE_URL = '…'`) and suggested folding it into `routeEndpoint.ts`
alongside `OPENAI_DEFAULT_ENDPOINT`. On acting, that fold is **wrong-direction**
and was not made: the two production importers are `src/model/glmRouting.ts:3`
(model layer) and `src/agent/runtime/run/routeEndpoint.ts:12` (agent layer),
and `routeEndpoint.ts` imports the constant **downward** from `@model`
(agent → model, the correct direction). Moving it into `routeEndpoint.ts` would
force `glmRouting.ts` to import it back **upward** (`src/model → src/agent`),
inverting the dependency direction the ratchets protect. The constant is shared
by a model-layer and an agent-layer module, so its home must be in the lower
(model) layer — where it already is. The one-line file is the correct price of
that layering, not a seam to collapse. The only sound consolidation (a single
provider-endpoint home under `@shared/constants/providers`, joining
`KIMI_CODE_BASE_URL`) is the "larger" option the audit itself said is not worth
a standalone PR. Withdrawn.

## 4. Subagent boundaries — unchanged from `-09-17`

- **`runAgentCreator` remains the one genuine "logical agent not yet running as
  one"** (`src/agent/implementations/agentCreator/agentCreatorFlow.ts`), a single
  linear `Effect.fn` behind the `AgentCreatorUI` port with one production caller
  running inline in the extension host. It stays **correctly open**: closing it
  is interactive-UI design work (the approval channel the public surface
  deliberately lacks), not a mechanical move.
- **The native-subagent SPI is shipped and clean**: `ChildRunStrategy<TTurn, R>`
  (`childRunLoop.ts`) driven by `startChildRunLoop`, with four distinct
  production construction sites (native subagent, workflow-script child,
  background bash, codex/claude CLI). This is the real working
  independent-agent boundary; an SDK would surface it as the delegation
  primitive rather than reinvent one.
- **`packages/llm` is the natural embeddable model unit** — a protocol-only
  `Model` owning no conversation state or retry policy. The `src/model/`
  route/subscription-decision cluster is a cohesive second unit if the SDK is
  ever split further, but needs no extraction today.

## 5. Bottom line

Fourteen consecutive passes find a green top-line verdict. The four audited
areas hold: the run loop's fold-based continuation, the cohesive `ModelInvoker` +
`runtime/run/*` model stack with no `ModelHandler` residue, the single-authority
logger with one redaction boundary and no silent degradation, and a clean,
provider-type-guarded SDK surface. The subagent SPI is a real four-implementor
contract; `agentCreator` is the single, correctly-open boundary. The wider 1.0
cleanup is executing (the survey's two passing-defects are already closed here).
The one net-new item was a stale `platform()` capability list in `CLAUDE.md`
(§3.1), now corrected in this PR at the maintainer's request; the §3.3 model
candidate was withdrawn as a false positive. Standing open work is unchanged:
**ratifying the Tier-1 public manifest** (keep-or-seal the
registry/`ToolHost`/`AgentPlatform` surface) and **shrinking the frozen
deep-import lists** — both being advanced on their own in-flight branches.
