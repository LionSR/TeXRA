# Multi-agent workflow UI: declared plan vs. issued calls

Status: slice 1 implemented 2026-08-28 (PR #11498); slice 2 implemented
2026-08-28 on top of it (engine `admitCall` gate, `awaitingApproval` status,
`callReview` on the proposal approve action, per-call review through the
existing proposal panel in both hosts) — the design below is what landed. Grounded on `origin/main` at `6fa2f8a2dd`.

## Problem

A `delegate_multi_agents` proposal is rendered as one aggregate — `6 tasks ·
1 phase`, the first declared phase labelled as if active, `meta.tasks` labels
listed as though they were the calls that will run, run-level files labelled
`Input`/`Context`/`Media` as though every call receives them, and one
agent/model as though every call used it. None of that is what executes:
`meta.tasks` is `{ id, label, phase? }` and nothing more (`WorkflowCallIdentitySchema`,
`src/shared/schemas/workflowCallProgress.ts`); a script may declare none and
issue every call from runtime data; a call chooses its own `agentName`,
`model`, `schema`, and files (`WorkflowAgentCallOptionsSchema`,
`src/agent/workflowScript/types.ts`).

## What the investigation found (verified at HEAD)

The data model already separates the two concepts; the presentation erased
the separation.

- **The execution snapshot is the one owner of both.** `WorkflowExecutionState`
  seeds one `planned`/`stageBlocked` stub per `meta.tasks` entry with empty
  files and no attempts, and `issueCall` materializes the real call —
  label, stage, agent, files — when the script issues `agent()`
  (`src/agent/workflowScript/workflowExecutionState.ts`). Dynamic calls are
  pushed only at issue time.
- **The projection to hosts was lossy.** `cardFor` in
  `src/tools/delegation/workflowScriptRun.ts` collapsed
  `planned`/`stageBlocked`/`queued` to one `planned` card and dropped
  `agent`, `files`, `childExecutionId`, `attempts`, `blockedReason`, and the
  model on any non-terminal card. The structured-vs-document contract was
  never stored anywhere: `options.schema` routed the child
  (`workflowScriptAgentRunner.ts`) and keyed the journal but reached neither
  state shape. Real concurrency was therefore invisible — a call waiting for
  one of the 4 p-queue slots looked identical to a plan label the run had
  not reached.
- **The two call shapes are not a dual-state system.** `WorkflowCallProgress`
  is a one-way projection of `WorkflowExecutionSnapshot.calls` (writer:
  `cardFor`/`settledWorkflowCall`; carrier: the `workflow.call` trace event;
  durable home: `WORKFLOW_TASK` stream-log rows). Enriching the projection is
  the incremental path; replacing it is not required.
- **The proposal payload is a synthetic workflow-agent proposal.**
  `WorkflowScriptTool.ts` builds a `WorkflowAgentProposal` whose
  `instruction` is `meta.description`, whose agent/model are the tool default
  and run model, with `memories: []`, `outputFiles: []`,
  `toolConfig: DEFAULT_TOOL_CONFIG`, plus `workflowScript: { name,
description, scriptPath, phases, tasks }` copied verbatim from `meta`.
  Approve-time model/agent overrides are discarded on this path (the panel
  hides the dropdowns for that reason).
- **Control is post-launch and CLI-only.** The only per-call control plane is
  `WorkflowScriptControl(childExecutionId, 'skip' | 'retry')`, keyed by the
  child execution id the runner reports _after_ launch, fanned out through
  the session's `WorkflowControlRegistry`; only the CLI child list exposes it
  (`s`/`r`). There is no pre-launch gate of any kind, no `interactive` flag
  (the attended/unattended fact is `approvalPromptsUnavailable`), and a
  skip is never journaled — a resumed run re-runs a skipped call.

## Conceptual model

Two things, never conflated:

1. **Workflow container** — name, description, declared phases, optional
   declared items (plan labels), files available to the script, defaults
   (agent, model), saved script. Known before execution. Says nothing about
   which calls run together, which depend on which, or whether a declared
   item is ever reached.
2. **Issued call** — exists only when the script issues `agent()`. Carries
   its result contract (`document` | `structured`), the agent and model it
   runs (declared by the script, then host-resolved), the files it was
   handed, queue/attempt state, child stream, cost, duration, error.

Presentation rules that follow: never present plan labels as calls; never
infer topology from phase membership or order; never show `0 tasks` for a
dynamic script; label defaults as defaults and run-level files as available
to the script; show concurrency only from `queued`/`running` calls.

The reference presentation is Claude Code's `/workflows` view: the
permission dialog shows name, description, and phase titles only; the
progress tree grows one row per agent as it is actually spawned, grouped by
phase, with live status and duration.

## Slice 1 — implemented

- `WorkflowExecutionCall` gains `issued: true` (stamped by `issueCall`,
  cleared on hydrate for non-reusable calls) and `kind`
  (`WORKFLOW_CALL_KIND`, from `options.schema`); `issueCall` also records the
  script-declared `model`, and `queueCall` restores that declaration after
  dropping a prior attempt's resolved facts.
- `WorkflowCallProgress` gains `kind`, `agent`, `model` (any status), and
  `files`; two live statuses, `declared` (an unissued plan label, whatever
  stage gate it sits behind) and `queued` (issued, waiting for a slot).
  Cards re-emit when the host resolves agent/model so a live row names what
  actually runs.
- Shared copy (`src/shared/copy/workflowCall.ts`) renders
  `Document · polish · gemini37f · introduction.tex · 1m 12s · $0.31`; a
  declared row stays a bare label. Both renderers and the headless line
  consume it unchanged; the CLI dashboard prefers the card's own model over
  the stream config.
- Proposal card, both hosts + headless, via
  `src/shared/copy/workflowScriptProposal.ts`: `2 phases · 3 declared items`
  or `2 phases · calls issued at runtime`; `Defaults: agent (model) — each
call may name its own agent and model.`; declared items grouped under
  their declared phase with an explicit "plan labels" note; `Files available
to the script`; the fake "active phase" (`phases[0]`) is gone. The CLI
  modal now shows the file groups it previously dropped. No change to the
  proposal wire schema.
- Host-stop recovery (`StreamLogStore`) settles `declared`/`planned`/`queued`
  rows as not-reached and only `running` rows as failed.

## Slice 2 — per-call / per-phase admission (design)

Goal: at proposal time choose _run all_ / _review each phase_ / _review each
call_; each review shows the call's resolved facts and reuses the existing
proposal panel; rejecting one call skips only that call; the existing
"approve all delegated work" stream bypass approves the rest.

Insertion point — the engine, before `queue.add`
(`runWorkflowScript.ts`, after the journal-replay check and before
`queueCall`): a new `WorkflowScriptRunOptions.admitCall?: (call) =>
Promise<'run' | 'skip'>` receiving `{ id, label, phase, kind, agent, model,
files (full paths), prompt, index }`. While awaiting it the call sits in a new
snapshot status `awaitingApproval` (projected as-is; label "Waiting for
approval"; sweep settles it as not-reached). `'skip'` takes the existing
interactive-skip path: settle `skipped`, return `WORKFLOW_SKIPPED_RESULT`,
never journal.

Invariants the gate must respect (all pinned by existing tests):

- Runs before `queue.add` — never holds a concurrency slot, never charges
  `liveCallCounter`, never reserves a stable attempt (a gate inside the
  runner would burn `MAX_STABLE_ATTEMPTS` per denial).
- Abort-responsive on `runAbort` and the per-call controller; classifies by
  `error.name`, not `instanceof`.
- Cached replays are admitted without prompting (no model work).
- Decisions are control-plane only: not journaled, not part of the call key;
  a resumed run re-prompts. Same rule as skip today.
- Headless (`approvalPromptsUnavailable`) installs no gate — identical to
  today's proposal carve-out in `proposalFlow.ts`.
- Snapshot writes coalesce; drive nothing off `onSnapshot`.

Host side (`WorkflowScriptTool` → `workflowScriptStrategy`): the proposal
decision gains `callReview?: 'none' | 'phase' | 'call'` on
`ProposalResult.approve` and the `AGENT_PROPOSAL_ACTION` approve message;
the extension's approve split menu and the CLI card gain the two review
items. `admitCall` resolves agent/model/files exactly as
`workflowScriptAgentRunner.prepare` does, builds a `WorkflowAgentProposal`
(document) or `ToolUseAgentProposal` (structured) with `instruction =
prompt`, and calls `requestDelegationProposal` — so the per-call review _is_
the existing panel, and the existing `autoApproved` bypass is the "approve
all remaining" action. A small optional `workflowCall: { workflowName,
callId, label, phase? }` field on the proposal lets the panel title itself
"Workflow call · Revise: Rewrite introduction". Phase scope prompts on the
first issued call of each stage (the only call known at that moment) and
records the stage as admitted or denied; a denied stage skips its later
calls. Honest limitation: a phase review cannot list the phase's future
calls, because they do not exist yet.

Out of scope for both slices, recorded: skip/retry has no IPC in the
extension/desktop hosts; `deriveWorkflowCounts` (delivery summary) and
`workflowPhaseCallProgress` (headers) deliberately count "done" differently;
dynamic-call progress ids are positional (`call-N`).

## Study: ultracode resume and display vs. TeXRA (2026-08-28)

A 28-agent workflow (4 readers, 2 judges, 2 adversarial verifiers per
recommendation) compared Claude Code's Workflow tool ("ultracode") with
TeXRA's engine, from local evidence: ultracode persists a per-run
`journal.jsonl` of `started`/`result` lines keyed by a `v2:` content hash,
per-agent transcripts, and a `wf_<id>.json` run record whose
`workflow_agent` entries carry `state`, `cached`, `model`, `phaseIndex`,
prompt/result previews and progress timestamps. Verdicts that survived
verification:

**Resume.**

- Ultracode replays the longest unchanged _prefix_; one dead agent at p85 forced
  16 re-runs in one record, an inserted call re-ran the 5 after it. TeXRA
  replays per call (same index, same key) and its key already covers prompt,
  id, agentName, model, schema, file paths and file bytes — broader than
  anything the ultracode evidence can show. Keep per-call replay; do NOT
  adopt the prefix rule or the append-only started/result protocol (it cannot
  distinguish never-finished from a null result, and would be a second owner
  beside the strict checkpoint + commit fence + child attempt ledger).
- Adopt: address the journal by key only, keeping `index` as an ordering fact
  (`runWorkflowScript.ts` `priorEntries`, `persistence.ts` uniqueness on key,
  schema v3→v4 failing loudly). Keys are already unique per run and the
  durable child id is already index-free, so the index buys only false misses
  on insertion/reorder; the honest win is that a shifted identical call
  replays from the journal instead of round-tripping the child ledger with a
  misleading `recovered` status. Do not prune the journal on success.
- Keep user skips and slice-2 admission denials per attempt, never journaled:
  the journal records outcomes of the script's calls; a human verdict belongs
  to the attempt that asked for it, and a resume is a new attempt.
- Say it where the model reads it: resuming needs the same `meta.name` _and
  the same agent_ — the default agent is part of the checkpoint identity, so
  changing it silently starts a new journal.
- Rejected: an extension/desktop attempt-boundary fold like the CLI's (the
  double-counting it assumed does not exist).

**Display.** Ultracode's default in-conversation view is one compact line;
its phase tree lives in `/workflows` and in the mobile background-tasks view
(run header name · elapsed · agents · tokens · description; one collapsible
per phase with `done/total`, a status-dot strip, and an Agent / Tokens / Time
table; future phases read "Waiting for agents…"). TeXRA's board already has
the richer structure; its defects were in the fold, not the layout:

- Phase stages never closed mid-run (only the `finally` ended them), so every
  entered phase read running with no duration until the whole script ended,
  and a failure in phase 3 marked phases 1-2 failed. Fixed: the projection
  closes a stage when the engine has settled it and every call of the stage
  is terminal (the schema has no "exited but draining" lifecycle, so the
  terminal-calls guard is forced, not defensive).
- Never-entered declared phases were opened at `finish()` and emitted a
  `Phase:` line. Fixed: a bypassed phase that owns no card is never opened.
- Declared cards for stage-blocked plan entries were emitted before their
  phase existed; the board classified them as ungrouped in the root timeline
  and they jumped into the phase when it opened — the literal "what is in
  which phase" failure. Fixed: a declared card exists only under an open
  phase (stage-blocked calls are not projected). The CLI plain output's
  early-card buffer became unreachable and was deleted.
- Cached (replayed) calls looked like completed ones; now a distinct icon.
  Retries were a card going running→queued→running with no explanation; the
  card now carries `attemptNumber` (from the second attempt on; label never
  rewritten).
- Phase header: `done/total · N running · N failed` plus one status dot per
  call; a whole-run band above the phases with the same fold. Both are folds
  over rows the board already holds — no new owner of counts (a shared
  three-surface tally and a settled-spend segment were refuted as second
  owners; run spend must come from the engine's tracker, not re-summed
  cards).
- Do NOT add `meta.phases[].detail` yet: no consumer; ultracode itself never
  renders it in the tree.

## Rejected

- **Static analysis of the script to pre-list calls** — a second, unsound
  model of what will run; the snapshot's `issued` fact is the truth.
- **A separate plan/dashboard state store** — `WorkflowCallProgress` is
  already a projection of the snapshot; enriching it costs no new owner.
- **Renaming `meta.tasks` on the wire** — copy fixes the misreading; a
  schema rename is churn with no new information.
- **Keeping the resolved model across requeue** — two persistence tests pin
  that a stale resolved model must not describe a fresh attempt; restoring
  the _declared_ model satisfies both contracts.
