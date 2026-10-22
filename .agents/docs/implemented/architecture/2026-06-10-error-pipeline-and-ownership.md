# Error pipeline and ownership

Status: implemented

One owner per concern on the error path: classify once at the provider
boundary, retry in one place, record a run's failure once as data on its
terminal row, present it once per host. This note states who owns what today,
the catch budget that keeps everything else from catching, and the traps that
earlier audits refused. The review rules that apply it are §6 and §15 of
`.claude/skills/code-review/references/review-checklist.md`; the event-channel
rule is in `CLAUDE.md` ("Event channels").

## Owners

| Concern                    | Owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider failure verdict   | `packages/llm`: a binding raises `ModelError`, and `packages/llm/src/api/verdict.ts` reads the vendor's reply once (status, retryable, route, window overflow, quota, lost continuation). Callers read those fields, never the SDK error behind them.                                                                                                                                                                                                                 |
| Harness-side normalization | `normalizeProviderError` (`packages/harness/src/common/errors/sdkError/providerErrorFormat.ts`) turns a failure into the canonical `ProviderError` (`@shared/schemas`) and caches it on the error under a `Symbol.for` key (`sdkError/errorMetadata.ts`), so every bundle reads one mark.                                                                                                                                                                             |
| Abort                      | `isUserAbort` (`packages/harness/src/common/errors/errorPredicates.ts`) is the one predicate. An abort is checked first, never retried, and ends a run `CANCELLED`, a sibling of `FAILED`.                                                                                                                                                                                                                                                                            |
| Retry                      | The run's invocation loop (`packages/harness/src/agent/runtime/run/invocation.ts`): `nextAttempt` reads the next move off the invocation's rows, automatic resends run under the process's `ModelRetryGate` within a budget the rows count, and a person's answer is the `request.decided` on the retry request a `failed` row opened. SDK-internal retries are off at every binding (`maxRetries: 0`; OpenRouter `retryConfig: { strategy: 'none' }`).               |
| Tool failures              | The dispatch (`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`): an ordinary tool failure becomes an error result the model reads; a durable write failure halts dispatch so an unsettled call is never recorded as successful.                                                                                                                                                                                                                           |
| A run's terminal failure   | `classifyAgentError` (`packages/harness/src/common/errors/agentErrorClassification.ts`) decides the kind once; `AGENT_ERROR_OUTCOME` maps each kind to its outcome. The kind is stored on the `run.end` row (`RunEndErrorSchema`, `packages/harness/src/shared/schemas/runRecords.ts`), and `ResultEvent` is that row's trace arm.                                                                                                                                    |
| Presentation               | `packages/harness/src/agent/runtime/terminalResultToast.ts` is the session's one terminal-failure presenter: it presents a root run's failure from its `run.end` row (child results go to the parent, not to a host) and replays it to a surface that attaches later. `attachErrorPresentationClaimed` marks a failure presented so no later presenter shows it again. A launch that fails before the run opens has no row; its launch presents it (`rootLaunch.ts`). |
| Event channels             | Run-scoped facts are `AgentEvent` (trace); facts the session authors are `SessionEvent` rows committed through the session log. `AppSignals` (`packages/harness/src/eventBus/AppSignals.ts`) carries app-lifecycle signals only.                                                                                                                                                                                                                                      |

**Only kinds with a verified producer ship.** `AgentErrorKind` is `abort`,
`context-window`, `disk-full`, `missing-api-key`, `unexpected`, plus
`result-lost`, which an end records and nothing throws. A new kind needs a
producer that reaches `classifyAgentError`; a producerless taxonomy (a
budget- or turn-exhaustion kind, a model-behaviour kind) is churn.

## Catch budget

Seven planes may catch; everything else returns typed failures or lets errors
reach one of them.

1. **Host entry boundaries**: extension command handlers via
   `showLoggedErrorMessage`, the CLI entry (`packages/cli/src/bin/texra.ts`),
   desktop IPC handlers.
2. **The provider boundary**: `ModelError` and its verdict in `packages/llm`,
   `normalizeProviderError` in the harness.
3. **The tool boundary**: the dispatch's error result back to the model.
4. **The run's terminal boundary**: `classifyAgentError`, decided once, stored
   on `run.end`.
5. **Listener fan-out isolation**: one subscriber's failure cannot kill its
   siblings (each `AppSignals` subscriber drains its own subscription).
6. **Resource cleanup**: Effect scopes and finalizers, `finally`,
   dispose-on-error, launch compensation.
7. **ENOENT-predicate reads**: `isFileNotFoundError`-only defaults that
   rethrow everything else.

A catch outside these planes carries the review-checklist §15 L1–L5
classification in its PR, and a Zod `.catch(default)` on persisted data is
never inside budget. The budget exists so masking catches only shrink: a new
one is a review blocker per checklist §15, and each cleanup lands as an
ownership transfer to one of the seven planes.

## Rejected findings (traps — do not pursue)

| Claim                                                                                          | Why rejected                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restructure the `Symbol.for` error marks into error classes or a "normalization service"       | The marks are the cross-bundle idiom on purpose: `instanceof` is as fragile across the extension, desktop and CLI bundles as across duplicated npm versions, and a `Symbol.for` key reads one mark in every bundle (the same idiom as Vercel AI SDK's error markers). Churn. |
| Present launch failures through the run's terminal result, deleting the launch's own presenter | A launch that fails before the run opens has no `run.end` row and no handle to emit from. The launch path keeps its own single owner (`presentRunFailure` in `rootLaunch.ts`, with `suppressErrorNotification` for callers that present themselves).                         |
| Re-enable SDK-internal retries, or add a retry layer beside the invocation loop                | Two retry owners hide attempts from the rows and the budget (the OpenRouter SDK default once backed off for up to an hour inside one visible attempt). Retry hints from the server belong in the one loop.                                                                   |
| A terminal error kind with no verified producer                                                | See "Only kinds with a verified producer ship" above: a kind no failure reaches is net-add taxonomy.                                                                                                                                                                         |
