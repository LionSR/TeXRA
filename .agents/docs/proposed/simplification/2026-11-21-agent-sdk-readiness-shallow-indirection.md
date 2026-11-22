# Agent SDK readiness: shallow indirection in the run loop and tool engine

Date: 2026-11-21
Status: proposed (the whole theme landed with this note; the open items below
are decision-gated and recorded so the theme is not re-mined)

Origin: a scheduled review of the harness for Agent SDK readiness — the agent
core, the model handler, the logger and the public host surface — looking for
unnecessary abstractions, wrapper layers and redundant interfaces that do not
add value, and for logical units that could run as independent agents. Read
against `main` at `362ab86`, continuing
[`2026-11-20-agent-sdk-readiness-audit.md`](2026-11-20-agent-sdk-readiness-audit.md)
and the agent-runtime items the recent merges (#15116, #15120, #15123)
unblocked.

## Headline

The SDK surface stays well-aligned; the 2026-11-20 run already confirmed every
forbidden import edge is zero and the run loop is one program with one
publisher. This run closed the no-decision indirection the recent feature
merges unblocked, and swept the agent core, tool engine, `packages/llm`, the
`./host` surface and the logger for two more species of shallow indirection.
What remains behind the design's goal is decision-gated and enumerated below.

## Landed with this note

**A result's own discriminant is read directly, not re-encoded by a
host-facing wrapper.** `presentFollowUpResult` (`@texra-ai/harness/host`)
re-encoded `SubmitFollowUpResult.status === 'failed'` as
`{ severity: 'warning', message }`, which every caller destructured and
branched on. Tracing the four callers showed the wrapper was carrying dead
weight:

- Only `executions/send.ts` (the in-process `executions send` tool, which calls
  `submitFollowUp` directly) ever saw `status === 'failed'`; it now reads the
  status itself.
- The three host callers receive the `followUp.send` **request** result, whose
  handler (`SessionRequests.ts`) lifts a failed send into an `Unavailable`
  error. Their success value is `{ kind: 'followUp'; status: 'queued' | 'sent' }`
  with no `'failed'` case, so `presentFollowUpResult` there always returned
  `{ severity: 'none' }` and its branch was dead. The failure is already
  surfaced through the error channel at each site (`hostRunActions.ts`'s
  `catchCause`, `chatSessionController.ts`'s `Effect.match.onFailure` →
  `'refused'`, and `TasksForm.tsx`'s `act` `onFailed` + `say`). The dead
  branches are removed; the export leaves `./host`.

**A two-value distinction read only as a boolean gets one boolean owner.** Four
internal string unions each had every read of the form `x === 'oneLiteral'`,
with no third branch, so each is a boolean:

- `FollowUps.release(next: 'recoverable' | 'terminal')` → `release(terminal: boolean)`
  (`agent/runtime/FollowUps.ts`); its one caller in `loop/runLoop.ts` passed
  `outcome === COMPLETED && !descendants ? 'terminal' : 'recoverable'`.
- `LiteralReplacementRequest.mode: 'unique' | 'all'` → `replaceAll: boolean`
  (`tools/fileEditFlow.ts`); `EditTool` had re-encoded its own `replace_all`
  boolean as `replace_all ? 'all' : 'unique'` only for the function to read it
  back. `MemoryTool` passed the constant `'unique'`.
- `ResolveWritableTargetOptions.missing?: 'allow' | 'require'` →
  `allowMissing?: boolean` (`tools/fileEditFlow.ts`); read once as
  `(options.missing ?? 'require') === 'require'`. `WriteTool` allows a missing
  file; `EditTool` uses the default.
- `agentToolResolution.ts`'s `source: 'declared' | 'injected'`, threaded through
  `offer` → `passesRuntimeGates` → `withheld`, → `declared: boolean`; every read
  was `source === 'declared'` ("injected" is just "not declared"), and the one
  label use is `declared ? 'Declared' : 'Injected'`.

None of these is persisted or on the wire, so no stored row, recorded tool
definition or API report changed except the `./host` surface losing
`presentFollowUpResult`.

## Checked and found clean (so a later run need not re-dig)

- **No other shallow presenter in the host surface.** `presentRunFailure` and
  `presentTerminalResult` (`agent/runtime/HostInteractions.ts`) carry real
  logic (error classification, `LaunchRefused.notice` extraction, a store-edge
  read, row-type gating). `formatDelivery`, `cardEnd` and the
  `executionFormatters` family are renderers and decoders, not trivial
  re-encodings. `host.ts` is canonical `export … from` re-exports, no forwarding
  wrappers.
- **No more two-value-union-as-boolean in the core.** The remaining two-literal
  unions in the agent core and tool engine are genuine tri-states
  (`RunCall.hook: 'allow' | 'ask'` with a distinct `undefined`;
  `operation?: 'bash' | 'call'`; `runModelDecision`'s
  `fallback: 'reject' | 'notice' | 'silent'`), discriminants carried downstream
  (`ModelInvoker.endedAs`'s `kind`), or labels that reach an on-disk artifact or
  message (`objectType` in a debug filename, `streamName`, `bash` grants). A
  sweep of `shared/`, `controllers/`, `model/`, `skills/` and `common/` turned
  up only labels (`role`, `by`, program-header `name`) and wire/digest roles,
  none a boolean.

## Open: needs an owner decision (unchanged from the 2026-11-20 run)

These Agent-SDK-readiness items were already costed and left for the owner;
none can land without the decision its source note names. Listed so the theme
is not re-mined.

1. **The product name an embedder's users still see is a persisted format**
   (`texra.db`, `TEXRA_APPROVAL_POLICY`, `TEXRA_SKILL_DIR`): a stored-name /
   env-key change deferred to the first release
   ([2026-11-20-agent-sdk-readiness-audit.md](2026-11-20-agent-sdk-readiness-audit.md)).
   Landed 2026-11-21: the names derive from the settings catalog's namespace.
2. Decided and landed 2026-11-21: the three product-visible defaults of
   [the model-access note](../../implemented/simplification/2026-11-18-model-access-one-owner-per-question.md)
   (one list of models for every surface, a delegation names only a model it
   was told, and `setModelAccessPreference` as the one writer).
3. Landed 2026-11-21 (`run.start.maxCostUsd`, `spendCap.ts`; a cap
   survives a resume). Was: **A child's spend cap is a fact of the waiting
   call, not of the run**
   ([2026-11-20-self-operation-left-open.md](2026-11-20-self-operation-left-open.md)
   §1): recording the cap on the child run's start, so `resources` reads the
   view instead of walking ancestors — a stored-row change for the first
   release.

## Subagent boundaries

Unchanged from the 2026-11-20 run: a run is already the independent-agent unit
(`executeAgent` / `launchProcessChild`), delegation launches children through
`childLaunch.ts`, and a plugin program is a run on a generated script. The two
feature merges since (the goal judge as a fresh `self()` run, the context tool)
extend exactly this seam. No new split is proposed; a second orchestration
layer beside the run loop is the shape the design doc rules out.

## Verified

- Read `main` at `362ab86`. `npm run typecheck` passed (8 projects, harness
  build and packed-example declarations). `npm run gate` passed (lint,
  invariants with the regenerated API reports, docs, typecheck, Effect
  diagnostics). `npm run test:changed`: 187 files, 495 passed, 1 skipped
  (16 changed files).
- Not run: a live model, the desktop and VS Code e2e.
