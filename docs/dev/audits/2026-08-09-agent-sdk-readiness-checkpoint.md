---
created: 2026-08-09
---

# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-09 at HEAD `bc37b57` from four parallel
> evidence passes (agent core+runtime, model handlers, logger/trace, package
> surface), every claim backed by `file:line` and grep'd caller counts. This is a
> _current-state_ re-measurement, not a new plan. It continues the near-daily
> checkpoint series — read alongside the immediately prior
> [`2026-08-08-agent-sdk-readiness-checkpoint.md`](./2026-08-08-agent-sdk-readiness-checkpoint.md)
> under the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Nothing here overrides a maintainer ruling or reopens a retired proposal.

## Verdict

**Unchanged: well-aligned, no structural refactor warranted.** Four independent
passes reproduce the standing conclusion of the `-05-29 → -08-08` chain. The only
genuine value-free wrapper in scope is the already-tracked `SessionHandle.useHostInteractions`
pass-through (PT-2); every other layer flagged by a generic "collapse the wrappers"
pass verifies as load-bearing. The open work remains packaging (Tier-1 public
manifest + bootstrap tax), not abstraction removal. This re-check adds **one new,
verified, net-negative cleanup delta** (§2), narrows two prior notes to nits (§3),
and records a **process observation** about this checkpoint series (§5).

## 1. Current-HEAD confirmations

- **The 2026-08-08 "landed this PR" items are present in the tree.**
  - §3-C `isOReasoningModel` relocation: **verified** — the method no longer
    exists on the host-agnostic base (`grep` of `ModelHandler.ts` is empty); it
    now lives in the OpenAI base (`modelHandlers/openai/{OpenAICompatibleModelHandler,modelHandlerOpenAI,modelHandlerOpenAIResponse}.ts`).
  - §3-A SDK-package ratchet coverage: **verified** — `hostAgentDeepImportRatchet.vitest.ts:28`
    now reads `const HOSTS = ['cli', 'desktop', 'extension', 'agent'] as const;`
    with `HOST_DIRS.agent → packages/agent/src` (`:44`); the SDK barrel's
    internal-coupling width is scanned and frozen at 10.
- **Deep-import baselines are still shrinking.** `host-agent-import-baseline.json`
  now records cli 31 / desktop 25 / extension 34 / agent 10, down from the
  39/32/25 pinned by the 2026-08-04 review — measured Tier-1 progress, not drift.
  Empirical `@agent/*` distinct-specifier grep (30/23/33/10) tracks the baseline;
  it is current, not stale.
- **Abstraction audit (core+runtime, model handlers) — nothing removable beyond
  PT-2.** `runAgent`→`executeAgent` carries ownership/registration/finalize
  semantics (options `Pick`ed from `ExecuteAgentOptions`, cannot drift); the
  14-implementation `ModelHandler` tree and its `Pick<>`-derived `IModelHandler`
  port are both load-bearing; `PROVIDER_HANDLER_ROUTES` is an exhaustive
  `Record<ModelProvider,…>` compile guard; the compatibility-key layer is the
  persisted resume-format identity, single-owned, not a second routing table. The
  `createRunScope` single-caller freeze wrapper (`RunScope.ts:25`) again matches
  the banned single-caller pattern and is again left as previously ruled (Keep).
- **Logger/trace split respected.** No `vscode` import under `src/logger/`;
  `OutputSink` is host-neutral; redaction is on by default (opt-out only via the
  CLI's `trusted` operator terminal); `setOutputChannelFactory` has exactly two
  production call sites plus a console default, for three genuinely distinct host
  behaviors — justified, not over-engineered.
- **Subagent boundaries — already designed and shipped.** `childRunLoop`'s
  `ChildRunStrategy<TTurn>` unifies all four child-run types behind one driver;
  lineage rides `ExecutionHandle`, detach policy is single-sourced in
  `detachSubagentsOnStop`. Nothing new to carve out. The cleanest _further_
  isolation candidates remain the read-only / helper-model one-shots
  (`sessionDescription` — already spawned detached at `executeAgent.ts:417`;
  `textEnhancement`; `review/`), all of which have well-defined I/O and no shared
  mutable state; `export/*` is a pure-function library boundary (no model call, not
  worth an agent), `followUp/*` is the coordination substrate (mechanism, not a
  candidate).

## 2. New delta — dead path-redaction capability + a parallel implementation (net-negative cleanup)

`redactSecrets(text, options)` (`src/logger/redaction.ts:86`) accepts a
`LogRedactionOptions` (`homeDir` / `workspacePath`, `:81-84`) and strips those
prefixes to `[path]` (`:90-93`, `:112-114`). **No caller anywhere passes
`options`** — all ~20 production call sites use the single-arg form (`grep` of
`redactSecrets` across `src/` and `packages/`), so the prefix-stripping branch is
**dead across the whole codebase**, not merely unreached at the sink. The channel
logger's `createRedactingSink` calls `redactSecrets(message)` with no options
(`logUtils.ts:61`); the transcript recorder and the CLI TUI sinks likewise.

Meanwhile the desktop app-log path does the same job through a **separate** local
helper: `redactSecrets(redactPathPrefixes(text, workspacePath, homedir()))`
(`packages/desktop/src/main/desktopAppLog.ts:167,174-175`). So there are two
path-redaction implementations, one of them dead.

This is a low-severity SSOT/dead-code finding (paths are not secrets, and secret-
pattern redaction — API keys, `Bearer`, JSON secret fields — _is_ applied on all
paths), but it matches the repo's own "exports are contracts / dead-code ratchet"
and "silent degradation is a defect" rules: the API advertises path redaction that
never runs. **Human decision required** (do not auto-change a security helper): either
wire the options through at the shared sink and retire `redactPathPrefixes`, or
delete the dead `options` branch and let `redactPathPrefixes` remain the single
owner. One reviewable PR either way; not urgent.

## 3. Prior notes narrowed to nits

- **`AnthropicStreamHandler` placement.** `modelHandlers/support/AnthropicStreamHandler.ts`
  (449 LoC, well-tested) is Anthropic-only — its sole non-`support/` production
  reader is `anthropic/modelHandlerAnthropic.ts` — yet lives in `support/`, which
  the README frames as cross-provider. A placement nit (arguably belongs in
  `anthropic/`), not an abstraction to collapse. Move only if the file is touched
  for another reason.
- **Logger two-idioms documentation gap.** The functional API
  (`debug/info/warn/error(channel,…)`) and `createChannelTrace(name)` write to the
  same per-channel sink; the "use which when" rule lives only in scattered TSDoc.
  A one-line note (functional API for leaf diagnostics; `createChannelTrace` only
  where an `AgentTrace` shape is structurally required outside a run) would close
  it. Cosmetic.

## 4. Already tracked — confirmed, not re-litigated

PT-2 (`SessionHandle.useHostInteractions` pass-through, `SessionHandle.ts:656`, 6
production callers + ~30 tests), the package-boundary type twins and duplicate
`AgentFlowResult`/`PendingInteractionKind` exports across `index.ts`/`schemas.ts`,
the public `AgentEvent` union carrying `@shared/schemas` host-typed arms
(`RunConfigEvent.config: AgentConfig`, `StatusEvent`), raw `StreamTabId` exposure
in `schemas.ts`, the withheld approval/retry interaction contract, the
`nodePlatform` agent-resource gap, and the `@shared/schemas` `forced` bucket
(~182 statements) all reproduce with fresh line numbers. All are pre-publish
surface/packaging items owned by the north-star track — recorded so this
checkpoint is not mistaken for discovering them.

## 5. Process observation

This checkpoint was produced by a scheduled routine running the standard
"audit agent core · model handler · logger · surface for SDK readiness" prompt.
That prompt is now substantially **duplicated** by this near-daily manual
checkpoint series (10 dated entries `2026-07-26 → 2026-08-08`, plus the
`2026-08-04` proposal-side review), several of which used the identical four-pass
method and reached the identical verdict. The marginal yield of a fresh full pass
is down to one net-negative cleanup delta per run (§2 here). Recommend the
maintainers **reconcile the two** — e.g. retire or lengthen the interval of the
scheduled routine, or repoint it at a narrower, higher-yield question (deep-import
baseline shrinkage progress; the `forced`-bucket follow-up; the pre-publish
surface decisions in §4) — rather than regenerating the same broad verdict.

## Bottom line

Agent core, model handlers, logger/trace, and the package surface remain aligned
with the Agent-SDK direction at HEAD `bc37b57`; guardrails are holding and, where
measured, still tightening (deep-import counts down, SDK-package width now
ratcheted). No unnecessary abstraction to remove beyond the tracked PT-2, and no
subagent boundary to newly design. The one fresh actionable item is the dead
path-redaction capability (§2); everything else is packaging-track work already
owned elsewhere.
