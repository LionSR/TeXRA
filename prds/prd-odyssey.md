# PRD: Odyssey — Autonomous Continuation Mode

**Status:** Draft (v0.1)
**Owner:** TBD
**Date:** 2026-05-14
**Branch:** `feature/odyssey`
**Worktree:** `/Users/siruilu/Local/AI-Projects/coauthor-goal`

## 1. Summary

Add **Odyssey** to TeXRA — a per-conversation persistent objective that lets a tool-use agent autonomously continue across many turns until a verifiable stopping condition is met. Inspired by Codex CLI's experimental `/goal` feature ([docs](https://developers.openai.com/codex/use-cases/follow-goals)).

The user sets an Odyssey from the stream header. While active, after every tool-use turn ends idle, TeXRA injects a hidden continuation message that re-prompts the agent to verify completion against current external state (filesystem, command output, tests) and either keep working or call `odyssey { command: 'complete' }`. The model self-terminates when the objective is met.

No new runtime, no polling loop, no background worker. The mechanism is a small injection at `ToolUseWaitNode.post()`.

## 2. Goals

- One persistent objective per conversation that survives across tool-use turns.
- Model can self-direct work for many turns without user input until the stopping condition holds.
- User retains full control: start, pause, resume, abandon, and edit-objective from the UI at any time.
- Zero new infrastructure: reuse the existing tool-use cycle, workspaceSM, settings webview tabs, and stream-header toolbar patterns.
- Feature-gated and opt-in (`texra.experimental.odyssey.enabled`); defaults off; ships as experimental.

## 3. Non-goals (v1)

- **No workflow-agent support.** Odyssey only applies to tool-use agents (orchestrator, devise, search, generic chat). Workflow agents (correct, polish, …) run once and emit output; "continuation" is meaningless.
- **No multi-agent orchestrator-level odyssey.** If a goal-bearing tool-use agent is itself a subagent of an orchestrator, the parent orchestrator owns continuation; the subagent's Odyssey is suspended for that subtree. Surfaces as a hard guard, not a feature.
- **No token budget.** Codex's public docs do not surface a budget; the internal one is purely accounting. We track tokens used for display only — no cap, no `BudgetLimited` status.
- **No slash command on extension/desktop.** Entry is the stream-header button and the Settings → Odyssey tab. (CLI host may add `/odyssey` later; out of scope here.)
- **No model-driven objective edits.** Codex restricts `update_goal` to `status='complete'` for the same reason: the model must not drift the target. The user edits objectives via the OdysseyTab.

## 4. Background — how Codex makes it work

The mechanism is mundane. Every "long-running" turn is many short turns chained:

1. A tool-use turn ends (model emitted final response, no more tool calls).
2. The runtime checks: is there an active goal? Is the user idle (no queued input)?
3. If yes, the runtime synthesizes a hidden user message:
   > `<goal_context>` Your goal is still: `<objective>`. Verify against the current filesystem/command output — not your memory. Call `update_goal(complete)` if done, else keep working. `</goal_context>`
4. That message is appended as the next turn's input, and the agent runs again — exactly like the user had said "keep going."
5. The model either calls `update_goal(complete)` (loop exits) or keeps working (back to step 1).

The model is the only thing that knows when the work is _actually_ done, so the model has to be given a tool that signals "stop the loop." Everything else (status display, pause/resume, accounting) is bookkeeping around that one loop.

TeXRA's `ToolUseWaitNode.post()` is the moral equivalent of Codex's idle hook — it's the function that decides whether to loop back to `ToolUseCycleNode` or exit. That's the entire integration point.

## 5. Architecture

### 5.1 Data model

`src/tools/odyssey/odysseyMeta.ts`:

```typescript
export const OdysseyStatusSchema = z.enum([
  'active',
  'paused',
  'complete',
  'abandoned',
]);

export const OdysseyEventSchema = z.object({
  at: z.string(), // ISO timestamp
  kind: z.enum([
    'started',
    'paused',
    'resumed',
    'objective_edited',
    'completed',
    'abandoned',
    'continuation_injected',
  ]),
  detail: z.string().optional(),
});

export const OdysseySchema = z.object({
  odysseyId: z.string(),
  conversationId: z.string(),
  objective: z.string().min(1),
  status: OdysseyStatusSchema,
  tokensUsed: z.number().int().nonnegative().default(0),
  timeUsedMs: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedReason: z.string().optional(), // populated by tool's 'complete'
  history: z.array(OdysseyEventSchema).default([]),
});
```

One Odyssey per conversation. Persisted via `workspaceSM` under `odysseys:byConversation:<conversationId>` plus an index `odysseys:index` for the OdysseyTab list view.

### 5.2 Tool surface

**Single tool, command-discriminated** — mirrors `MemoryTool`'s shape (`src/tools/memory/MemoryTool.ts:48-93`):

```typescript
export const ODYSSEY_TOOL_NAME = 'odyssey' as const;

const OdysseyToolInputSchema = z.strictObject({
  command: z.enum(['view', 'start', 'pause', 'complete']),
  objective: z.string().nullish(), // required for 'start'
  reason: z.string().nullish(), // required for 'pause' and 'complete'
});
```

| Command    | Use                                                                       | Effect                                                        |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `view`     | Read situational awareness (objective, status, history, time/tokens used) | No mutation; returns formatted state                          |
| `start`    | Open an odyssey from conversation when user requests autonomous work      | Creates with status `active`. Fails if one is already active. |
| `pause`    | Self-pause when blocked and needing user input                            | Status → `paused`. Continuation loop stops.                   |
| `complete` | Signal objective met                                                      | Status → `complete`. Stores `reason` as audit sentence.       |

Commands deliberately omitted: `update_objective` (model must not drift the target), `resume` (only the user can clear a block), `abandon` (destructive, user-only).

### 5.3 The continuation hook

`src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts` — adds ~20 lines to `.post()`:

```
if (no user followUp queued && not interrupted && feature flag on) {
  goal ← OdysseyStore.getForCurrentConversation()
  if (goal?.status === 'active') {
    item ← buildContinuationFollowUp(goal)
    record event 'continuation_injected'
    return { transition: CONTINUE, followUp: [item] }
  }
}
return originalDecision
```

`buildContinuationFollowUp(goal)` renders `resources/odyssey/odyssey.yaml > continuation.template` with `{{objective}}` and `{{timeUsed}}` substitutions, wrapped in `<odyssey_context>…</odyssey_context>` XML tags.

### 5.4 Prompts (YAML)

`packages/extension/resources/odyssey/odyssey.yaml`:

```yaml
continuation:
  description: Injected at the end of an idle turn while odyssey is active
  template: |
    <odyssey_context>
    Your odyssey is in progress.

    Objective: {{objective}}
    Time elapsed: {{timeUsed}}

    Verify against the actual filesystem and command output — not your
    memory — whether the objective and its stopping condition are met.
    If yes, call `odyssey` with command="complete" and a reason citing
    the verification evidence. If not, continue working in scoped
    checkpoints.
    </odyssey_context>

objective_updated:
  description: Injected once after the user edits the objective
  template: |
    <odyssey_context>
    The user has updated the odyssey objective. This overrides earlier context.

    New objective: {{objective}}

    Re-orient against the new objective before continuing.
    </odyssey_context>
```

### 5.5 IPC namespace

`src/shared/schemas/odysseyViewMessages.ts` — mirrors `memoryViewMessages.ts`. Discriminated union for `startOdyssey | pauseOdyssey | resumeOdyssey | abandonOdyssey | editObjective | getOdysseyStatus` (UI → host) and `odysseyUpdated` (host → UI). Re-exported from `settingsViewMessages.ts`.

### 5.6 UI surfaces

**Stream header (PR 2)** — `packages/extension/src/progressView/frontend/components/StreamHeader.ts`:

- Row 1: new `ELEMENT_IDS.ODYSSEY_TOGGLE_BTN` next to yolo/super-yolo. Click opens popover (start objective / pause / resume / abandon).
- Row 2 (conditional, only when status is `active` or `paused`): full-width context band showing odyssey icon, truncated objective, tokens-used chip, elapsed-time chip, pause/resume button, abandon button. Disappears entirely when no Odyssey is active so the header stays slim by default.

**Settings → Odyssey tab (PR 2)** — `packages/extension/src/settingsView/frontend/tabs/OdysseyTab.ts`. Cross-conversation list of odysseys, read/edit/abandon. Mirrors `MemoryTab`.

**Progress board entry (PR 2)** — odyssey shows as a long-lived task while active, alongside other in-flight work.

### 5.7 Feature flag

`texra.experimental.odyssey.enabled` (default `false`), declared in `package.json` contributes. Checked at three points:

1. Tool registry — the `odyssey` tool is only registered when the flag is on.
2. Wait-node hook — continuation injection is skipped when the flag is off (even if a stale Odyssey record exists from prior runs).
3. UI surfaces — header button + Settings tab are hidden when off.

## 6. File layout

```
src/shared/schemas/
  odysseyViewMessages.ts              NEW
  settingsViewMessages.ts             MODIFY (re-export)

src/tools/odyssey/
  OdysseyTool.ts                      NEW
  odysseyMeta.ts                      NEW  (Zod schemas, constants)
  odysseyStore.ts                     NEW  (workspaceSM wrapper)
  index.ts                            NEW

src/agent/odyssey/
  buildContinuationFollowUp.ts        NEW  (YAML template render)
  applyTurnAccounting.ts              NEW  (tokens/time bookkeeping)

src/agent/implementations/flows/tooluse/nodes/
  ToolUseWaitNode.ts                  MODIFY (~20 lines)

src/tools/registry.ts                 MODIFY (conditional registration)

packages/extension/resources/odyssey/
  odyssey.yaml                        NEW

packages/extension/src/settingsView/
  frontend/tabs/OdysseyTab.ts                          NEW   (PR 2)
  frontend/components/odyssey/OdysseyList.ts           NEW   (PR 2)
  frontend/components/odyssey/OdysseyEditor.ts         NEW   (PR 2)
  utils/odysseyFileSystem.ts                           NEW   (PR 2)
  SettingsViewMessageHandler.ts                        MODIFY (PR 2)

packages/extension/src/progressView/frontend/components/
  StreamHeader.ts                     MODIFY (PR 2)
  constants.ts                        MODIFY (PR 2 — ELEMENT_IDS.ODYSSEY_TOGGLE_BTN)

package.json                          MODIFY (contributes.configuration entry)
```

## 7. Phased rollout

**PR 1 — Core mechanism (no rich UI).** Schema, store, OdysseyTool, wait-node continuation hook, IPC schema, YAML prompt bundle, feature flag, tool-registry gating. Validation: a temporary debug log line + manual `odyssey { view }` call from the model in dev exercises the loop. No header button, no Settings tab.

**PR 2 — UI surfaces.** StreamHeader expansion (Row 1 toggle button + Row 2 context band), Settings Odyssey tab, progress board entry, abandon-on-conversation-delete hook. Pure UI on top of working core.

## 8. Risks and mitigations

| Risk                                                             | Mitigation                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model drifts away from the stated objective over many turns      | Continuation prompt insists on verifying against _current external state_ (Codex's own guardrail). Model has no tool to edit the objective.                                        |
| Token accounting becomes stale and the badge shows wrong numbers | TeXRA already emits usage per response; apply to odyssey record at the same time as the existing usage event. Off by ≤1 turn in worst case — acceptable for an informational chip. |
| Multi-agent orchestration interferes with continuation           | Hard guard in the wait-node hook: if the current node is inside an orchestrator-driven subagent, skip injection; the parent owns continuation.                                     |
| User clears a conversation but the Odyssey record lingers        | Subscribe to the existing conversation-delete event in PR 2; mark odyssey `abandoned` and drop from index.                                                                         |
| Webview reconnect shows stale odyssey state                      | State lives in `workspaceSM`; the OdysseyTab and StreamHeader band fetch on mount and on `odysseyUpdated` IPC events.                                                              |

## 9. Open questions

- Should `start` from the model auto-activate, or require user confirmation? Codex auto-activates. PR 1 ships auto-activate; revisit if it surprises users.
- Maximum history length for the `events` array? Cap at 200 events per Odyssey, oldest dropped on overflow.
- Cross-host story for CLI (`@texra/cli`) — likely a `texra odyssey` subcommand mirroring the IPC messages. Out of scope for this PRD.

## 10. References

- Codex `/goal` user-facing docs: https://developers.openai.com/codex/use-cases/follow-goals
- Codex internals scout (this conversation): turn-end idle hook at `codex-rs/core/src/tasks/mod.rs:802`, continuation candidate check at `codex-rs/core/src/goals.rs:1301`, ThreadGoal schema at `codex-rs/state/src/model/thread_goal.rs:52`.
- TeXRA tool pattern reference: `src/tools/memory/MemoryTool.ts` (single tool with `command` enum discriminator).
- TeXRA wait-node integration point: `src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts:39-114`.
