# Agent SDK readiness: what the 2026-11-23 audit landed, and what it left

Date: 2026-11-23
Status: proposed (one theme landed with this note; the rest are below the PR
bar on their own or need an owner decision)

Origin: a scheduled review of the harness for Agent SDK readiness — the agent
core, the model handler, the logger and the public host surface — looking for
unnecessary abstractions, wrapper layers, pass-through indirection,
single-caller helpers, re-export shims and redundant interfaces, and for
logical units that could run as independent agents. Read against `main` at
`6b29e26`, continuing
[`2026-11-20-agent-sdk-readiness-audit.md`](2026-11-20-agent-sdk-readiness-audit.md)
and
[`2026-11-21-agent-sdk-readiness-shallow-indirection.md`](2026-11-21-agent-sdk-readiness-shallow-indirection.md),
after the merges those runs did not see (#15145 an agent runs itself, #15163
file-based memory, #15180/#15183 programs in place of agents, #15186 project
data versions, #15192 retire merge program). A 23-mapper read of the
model-invocation, run-loop, model-handler, model-access, logger and public-entry
seams; the six candidates that reached adversarial verification are below.

## Headline

The SDK surface stays well-aligned; the seam maps found the model-invocation,
run-loop and model-handler seams "substantially healthy and well-factored",
with no dual system, no pass-through to delete and no single-source conflict in
any of them. This run landed three duplicated facts given one owner each (a
program's launch grants, the unsupported-stream-event rejection, the effort
vocabulary) and one accidental single-field wrapper removed. The remaining four
candidates are below the element/LoC bar on their own or need an owner
decision, and are recorded here so the theme is not re-mined.

## Landed with this note

**One owner for a program's launch grants.** The #15145 three-way
`programOrigin` split (`listed` / `installed` / `own`) made the grant a
program's launch gets from its origin a two-column fact, and that fact was
written three times: `step.ts`'s `grants` compound (`{toolsFixed,
startsApproved}`), `proposalFlow.ts`'s `approved` (= the `startsApproved`
column, `origin !== 'own'`) and `AgentTool.ts`'s `verbatim` (= the `toolsFixed`
column, `origin === 'listed'`), each a separate object literal with its own
`satisfies Record<ProgramOrigin, …>`. The columns genuinely diverge on the
`installed` row, so this is a real dual (triple) representation, not a special
case written as data. The three re-spellings now read one owner,
`programGrants` (`shared/schemas/runRecords.ts`), beside `programOrigin`, which
keeps the exhaustive `satisfies Record<ProgramOrigin, ProgramGrants>` in one
place — so a fourth origin forces one decision, not three. The fields are named
for the fact (`appAuthored`, `startsApproved`), not the local effect. No
persisted or wire change; `programGrants` stays internal (no consumer outside
the harness), so the public `./schemas` report is unchanged. This landed option
(b) of the refused candidate `RUN-trusted-script-launch-grants`; its
`refuted-candidates.json` entry is rewritten in the same PR with the new
evidence, and now refuses only option (a), a stored copy.

**A single-field wrapper that fought the field's own name.** `AgentRun.ts`
wrapped the run's one progress callback in a file-local `RunCallbacks`
interface (`{ onProgress? }`), read as `run.callbacks.onProgress` at four sites
although every other layer names the field `onProgress` directly
(`ExecuteAgentOptions`, `childLaunch`, `resumeRun`). The wrapper is gone;
`onProgress` sits on `AgentRunShape` and `AgentRunLayerInput` directly, which
also removes the name mismatch. File-local, no public surface.

**One owner for the unsupported-stream-event rejection.**
`openaiResponsesCodec.ts` open-coded the same `ModelError`
(`provider-rejection`, `retryable: false`, "`<provider> sent a stream event
of a type this version does not support`") that `transport.ts`'s
`refuseUnknownEvent` already constructs for the Anthropic and Google codecs —
the two differ only because the Responses codec dispatches by type and falls
through, while the others check a `known` set. Extract
`unsupportedStreamEvent(provider, type)` in `transport.ts` (beside
`wireFail`) as the one owner of that wording and shape; `refuseUnknownEvent`
and the Responses codec both use it. Internal to `packages/llm`, no wire
change.

**One owner for the effort vocabulary in `turn.ts`.** `ThinkingLevelSchema`
re-spelled `['minimal','low','medium','high','xhigh']` as a fresh
`Schema.Literals`, while its sibling `EffortSchema` one block up already derives
its subset with `ReasoningEffortLevelSchema.pick(...)`. `ThinkingLevelSchema`
now picks from the same base, so the effort literals have one source. The
literal values are unchanged, so no wire, JSON-schema or digest impact.

## Open: left for a decision or a broader pass

None of these can land as a net win on its own; each needs either an owner
decision or a broader pass to sit in. Listed so the theme is not re-mined.

1. **Flatten the public `ToolPolicy` single-field wrapper
   (`{ stopAfterCycle? }`) to a bare field.** Verified genuinely single-field,
   no external reader of `.toolPolicy`. Left open for two reasons: its TSDoc
   (`AgentRun.ts`) frames the wrapper as deliberate SDK-embedder headroom ("the
   property an SDK embedder wants"), so whether to keep the named concept is the
   owner's call; and it is on the public `@texra-ai/worldline/plugins` surface
   (`pluginSurface.ts`) and the `ToolContext` type, with ~24 construction sites
   across 23 test files, so the source saving is largely cancelled by fixture
   churn. If the owner wants the wrapper gone, it is a pre-1.0 SDK-surface
   change (docgen/api-report regenerate) plus the fixture sweep.

2. **Merge `priceTurnUsage` + `reportUsage` into one `priceAndReport`**
   (`agent/runtime/run/pricing.ts`). Called as an adjacent pair at
   `modelCall.ts` and `recordFailure`, but at `ModelInvoker.consume` the priced
   usage is stamped on the durable `response` row _between_ the price and the
   report, so a full merge moves the usage-log write ahead of the durable
   append. `reportUsage` is documented fire-and-forget, so the reorder is almost
   certainly unobservable, but it is a crash-window change to process
   accounting — AGENTS.md flags that sensitive. Blocked on the owner accepting
   report-before-append; without it, the export survives and nothing is deleted.

3. **Collapse `ModelAccess.inProject`'s six one-by-one `Effect.provideService`
   calls onto `Context.pick`** (`agent/runtime/modelAccess/ModelAccess.ts`).
   This is the hand-rolled context-forwarding the root AGENTS.md mandate
   replaces, and `Context.pick` is already the idiom at 11 harness sites; this
   is the lone holdout. But it deletes no named symbol and, with the six tags
   re-listed in both the capture and the type, is roughly line-neutral under
   oxfmt. Worth doing only folded into a repo-wide "forward captured context via
   `Context.pick`" pass, not as a standalone diff.

4. **Inline the single-caller `agentsMd` micro-module into `PromptBuilder`**
   (`agent/prompt/`). `loadAgentsMd` has exactly one consumer, which the
   find-simplification guardrail flags. But it is a cohesive deep module
   (two-root load, merge, error shaping) whose concern differs from prompt
   assembly, created deliberately the same day in #15163; inlining ~50 lines
   into `buildOpeningSystemPrompt` mixes altitudes. A wash — defensible to
   leave, worth doing only inside a broader prompt-module consolidation.

## Subagent boundaries

Unchanged from the 2026-11-20 and 2026-11-21 runs: a run is already the
independent-agent unit (`executeAgent` / `launchProcessChild`), delegation
launches children through `childLaunch.ts`, and a plugin program is a run on a
generated script. The merges since (an agent that runs itself, its own
programs, hot-plugged native plugins) extend exactly this seam. No new split is
proposed; a second orchestration layer beside the run loop is the shape the
design doc rules out.

## Verified

- Read `main` at `6b29e26`. `npm run gate` passed (lint, invariants with the
  API reports, docs, typecheck across 8 projects with the harness build and
  packed-example declarations, Effect diagnostics clean). `npm run docgen`:
  no public-surface change. `npm run test:changed`: 244 files, 634 passed, 1
  skipped (13 changed files).
- Not run: a live model, the desktop and VS Code e2e.
