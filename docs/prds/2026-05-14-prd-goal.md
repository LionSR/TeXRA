---
created: 2026-05-14
updated: 2026-06-09
---

# PRD: Goal — Autonomous Continuation Mode

**Status:** Draft (v0.3)
**Owner:** TBD
**Date:** 2026-05-14

## 1. Summary

Add **Goal** to TeXRA — a per-conversation persistent objective that lets a tool-use agent autonomously continue across many turns until a verifiable stopping condition is met or a safety checkpoint is reached. Inspired by Codex CLI's experimental `/goal` feature ([docs](https://developers.openai.com/codex/use-cases/follow-goals)).

The user sets a Goal from the stream header. While active, after every tool-use turn ends idle, TeXRA injects a hidden continuation message that re-prompts the agent to verify completion against current external state (filesystem, command output, tests) and either keep working or call `goal { command: 'complete' }`. The model self-terminates when the objective is met.

No new runtime, no polling loop, no background worker. The mechanism is a small injection before `session.waitForFollowUp` in `ToolUseWaitNode.exec()`.

## 2. Goals

- One persistent objective per conversation that survives across tool-use turns.
- Model can self-direct work for many turns without user input until the stopping condition holds or a configured continuation cap is reached.
- User retains full control: start, pause, resume, abandon, and edit-objective from the UI at any time.
- Zero new infrastructure: reuse the existing tool-use cycle, workspaceSM, settings webview tabs, and stream-header toolbar patterns.
- Feature-gated and opt-in (`texra.experimental.goal.enabled`); defaults off; ships as experimental.

## 3. Non-goals (v1)

- **No workflow-agent support.** Goal only applies to tool-use agents (orchestrator, devise, search, generic chat). Workflow agents (correct, polish, …) run once and emit output; "continuation" is meaningless.
- **No multi-agent orchestrator-level goal.** If a goal-bearing tool-use agent is itself a subagent of an orchestrator, the parent orchestrator owns continuation; the subagent's Goal is suspended for that subtree. Surfaces as a hard guard, not a feature.
- **No token accounting at all.** Codex's public docs do not surface a token budget, and the per-stream token count adds storage churn and UI noise for limited value. v1 uses a simpler operational stop: a maximum continuation count, after which Goal pauses and asks the user whether to continue.
- **No slash command on extension/desktop.** Entry is the stream-header button and the Settings → Goal tab. (CLI host may add `/goal` later; out of scope here.)
- **No model-driven objective edits.** Codex restricts `update_goal` to `status='complete'` for the same reason: the model must not drift the target. The user edits objectives via the GoalTab.

## 4. Background — how Codex makes it work

The mechanism is mundane. Every "long-running" turn is many short turns chained:

1. A tool-use turn ends (model emitted final response, no more tool calls).
2. The runtime checks: is there an active goal? Is the user idle (no queued input)? Has the continuation cap not been reached?
3. If yes, the runtime synthesizes a hidden user message:
   > `<goal_context>` Your goal is still: `<objective>`. Verify against the current filesystem/command output — not your memory. Call `update_goal(complete)` if done, else keep working. `</goal_context>`
4. That message is appended as the next turn's input, and the agent runs again — exactly like the user had said "keep going."
5. The model either calls `update_goal(complete)` (loop exits), keeps working (back to step 1), or reaches the continuation cap, at which point the loop pauses for user confirmation.

The model is the only thing that knows when the work is _actually_ done, so the model has to be given a tool that signals "stop the loop." Everything else (status display, pause/resume, accounting) is bookkeeping around that one loop.

TeXRA's `ToolUseWaitNode.exec()` is the correct idle hook because it runs before the blocking follow-up wait. `ToolUseWaitNode.post()` remains a simple mapper from the wait result to the next flow transition.

## 5. Architecture

### 5.1 Data model

`src/tools/goal/goalMeta.ts`:

```typescript
export const GoalStatusSchema = z.enum([
  'active',
  'paused',
  'complete',
  'abandoned',
]);

export const GoalEventSchema = z.object({
  at: z.iso.datetime(),
  kind: z.enum([
    'started',
    'paused',
    'resumed',
    'objective_edited',
    'completed',
    'abandoned',
    'continuation_injected',
  ]),
  detail: z.string().nullish(),
});

export const GoalSchema = z.object({
  goalId: z.string(),
  streamId: z.string(), // stream-scoped — matches ToolUseWaitNode.services.streamId
  objective: z.string().min(1),
  status: GoalStatusSchema,
  continuationCount: z.int().nonnegative().prefault(0),
  maxContinuations: z.int().positive().prefault(50),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedReason: z.string().nullish(), // populated by tool's 'complete'
  history: z.array(GoalEventSchema).prefault([]),
});
```

One Goal per stream. Persisted via `platform().workspaceState` (host-neutral `StateStore`, see `src/platform/interfaces/state.ts`) under `goals:byStream:<streamId>` plus an index `goals:index` for the GoalTab list view. The same store is backed by VS Code's Memento in the extension host, by an in-memory store under test, and by a file-backed store in CLI/desktop — no `vscode` import in this code path.

The store enforces bounded state growth. `recordEvent` trims `history` to the most recent 200 events after every write. Each injected continuation increments `continuationCount`; if it reaches `maxContinuations`, the store pauses the Goal and records a cap-reached event instead of returning another continuation.

### 5.2 Tool surface

**Single tool, command-discriminated** — mirrors `MemoryTool`'s shape (`src/tools/memory/MemoryTool.ts:48-93`):

```typescript
export const GOAL_TOOL_NAME = 'goal' as const;

const GoalToolInputSchema = z.strictObject({
  command: z.enum(['view', 'start', 'pause', 'complete']),
  objective: z.string().nullish(), // required for 'start'
  reason: z.string().nullish(), // required for 'pause' and 'complete'
});
```

| Command    | Use                                                                                       | Effect                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `view`     | Read situational awareness (objective, status, history, time elapsed, continuation count) | No mutation; returns formatted state                                                       |
| `start`    | Open a goal from conversation when user requests autonomous work                          | Creates with status `active`. Fails if any nonterminal Goal already exists for the stream. |
| `pause`    | Self-pause when blocked and needing user input                                            | Status → `paused`. Continuation loop stops.                                                |
| `complete` | Signal objective met                                                                      | Status → `complete`. Stores `reason` as audit sentence.                                    |

Commands deliberately omitted: `update_objective` (model must not drift the target), `resume` (only the user can clear a block), `abandon` (destructive, user-only).

### 5.3 The continuation hook

`src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts` — the wait-and-decide logic lives in `.exec()`. The hook sits **before** the existing `session.waitForFollowUp` call (currently at line 69): if an active Goal is present and the user has not queued input, the hook synthesizes a followUp and returns immediately, short-circuiting the blocking wait. `.post()` is purely a mapper from `WaitExecResult` to `FlowTransition` and is untouched.

Two correctness invariants this pseudocode preserves:

1. **User interruption stops the loop.** When `checkInterruption()` is true (the user cancelled), the early-exit at the top returns `{ kind: 'stop' }` before the continuation check can run. An active goal never overrides an explicit user cancel.
2. **Continuation does not deadlock on the wait.** `session.waitForFollowUp` blocks indefinitely on an empty queue; if the continuation check ran _after_ the wait it would be unreachable in the happy path (idle user, active goal). Continuation therefore runs **before** the blocking wait. The wait remains the path for "no goal, idle user" (which is the existing terminal behavior).

```
async exec(prep) {
  const { checkInterruption, session, streamId, isSubagent, runtimeHost, ... } = this.services;

  // (1) Honour interruption first — never overridden by goal.
  if (checkInterruption()) return { kind: 'stop' };

  if (prep.afterError && isSubagent) return { kind: 'stop' };
  if (!prep.afterError) await onBeforeWaiting?.(...);

  // (2) Try goal continuation BEFORE the blocking wait.
  //     Subagents, queued user input, and disabled flag all bypass this branch.
  const synth = await maybeBuildGoalContinuation({
    streamId,
    isSubagent,
    hasQueuedFollowUp: session.hasQueuedFollowUp(),
  });
  if (synth) {
    return { kind: 'continue', followUp: synth };
  }

  // (3) Otherwise fall through to the existing wait behavior.
  if (!session.hasQueuedFollowUp()) {
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING, { runtimeHost });
  }
  const items = await session.waitForFollowUp(checkInterruption);
  if (!items || checkInterruption()) return { kind: 'stop' };
  return { kind: 'continue', followUp: items.join('\n\n') };
}

// Helper (lives in src/agent/goal/), keeps the wait-node edit small.
async function maybeBuildGoalContinuation(args: {
  streamId: string;
  isSubagent: boolean;
  hasQueuedFollowUp: boolean;
}): Promise<string | null> {
  if (args.isSubagent) return null;            // parent orchestrator owns continuation
  if (args.hasQueuedFollowUp) return null;     // user input takes precedence
  if (!platform().config.get('texra.experimental.goal.enabled', false)) return null;
  const goal = await GoalStore.getForStream(args.streamId);
  if (goal?.status !== 'active') return null;
  if (goal.continuationCount >= goal.maxContinuations) {
    await GoalStore.pauseForContinuationCap(goal.goalId);
    return null;
  }
  await GoalStore.recordEvent(goal.goalId, 'continuation_injected');
  return buildContinuationFollowUp(goal);
}
```

`buildContinuationFollowUp(goal)` renders `resources/goal/goal.yaml > continuation.template` with `{{objective}}` and `{{timeUsed}}` substitutions, wrapped in `<goal_context>…</goal_context>` XML tags. Continuation is **suppressed when `services.isSubagent` is true** — the parent orchestrator owns continuation for any subagent subtree.

### 5.4 Prompts (YAML)

`packages/extension/resources/goal/goal.yaml`:

```yaml
continuation:
  description: Injected at the end of an idle turn while goal is active
  template: |
    <goal_context>
    Your goal is in progress.

    Objective: {{objective}}
    Time elapsed: {{timeUsed}}

    Verify against the actual filesystem and command output — not your
    memory — whether the objective and its stopping condition are met.
    If yes, call `goal` with command="complete" and a reason citing
    the verification evidence. If not, continue working in scoped
    checkpoints.
    </goal_context>

objective_updated:
  description: Injected once after the user edits the objective
  template: |
    <goal_context>
    The user has updated the goal objective. This overrides earlier context.

    New objective: {{objective}}

    Re-orient against the new objective before continuing.
    </goal_context>
```

The `objective_updated` template is injected by the host's edit-objective handler: on receipt of the `EDIT_OBJECTIVE` IPC message (see §5.5), the handler updates the Goal record and calls `session.appendFollowUp(rendered)` on the active stream's tool-use flow. The model sees the new objective as the next user-facing turn input. No template is ever injected when the stream is idle without an active Goal.

### 5.5 IPC namespace

`src/shared/schemas/goalViewMessages.ts` — follows the exact convention of `memoryViewMessages.ts:47–146`: an `GOAL_VIEW_COMMANDS` constants object keyed by UPPER_SNAKE_CASE, each message schema declaring `command: z.literal(GOAL_VIEW_COMMANDS.<KEY>)`, all assembled into a `z.discriminatedUnion('command', [...])`. Re-exported from `settingsViewMessages.ts`.

```typescript
export const GOAL_VIEW_COMMANDS = {
  START_GOAL: 'startGoal',
  PAUSE_GOAL: 'pauseGoal',
  RESUME_GOAL: 'resumeGoal',
  ABANDON_GOAL: 'abandonGoal',
  EDIT_OBJECTIVE: 'editObjective',
  GET_GOAL_STATUS: 'getGoalStatus',
  GOAL_UPDATED: 'goalUpdated', // host → UI
} as const;
```

UI → host: `START_GOAL`, `PAUSE_GOAL`, `RESUME_GOAL`, `ABANDON_GOAL`, `EDIT_OBJECTIVE`, `GET_GOAL_STATUS`. Host → UI: `GOAL_UPDATED`. The CLI host has no webview but reuses the same schema for any future `texra goal` subcommand (a CLI command translates to the same UI-side message and ends in the same handler).

### 5.6 UI surfaces

**Stream header (PR 2)** — `packages/extension/src/progressView/frontend/components/StreamHeader.ts`:

- Row 1: new `ELEMENT_IDS.GOAL_TOGGLE_BTN` next to yolo/super-yolo. Click opens popover (start objective / pause / resume / abandon).
- Row 2 (conditional, only when status is `active` or `paused`): full-width context band showing goal icon, truncated objective, tokens-used chip, elapsed-time chip, pause/resume button, abandon button. Disappears entirely when no Goal is active so the header stays slim by default.

**Settings → Goal tab (PR 2)** — `packages/extension/src/settingsView/frontend/tabs/GoalTab.ts`. Cross-conversation list of goals, read/edit/abandon. Mirrors `MemoryTab`.

**Progress board entry (PR 2)** — goal shows as a long-lived task while active, alongside other in-flight work.

### 5.7 Feature flag

`texra.experimental.goal.enabled` (default `false`).

In the extension host, declared via `contributes.configuration` in `packages/extension/package.json`. In the desktop and CLI hosts, declared in each host's settings/`config.toml` schema. All three are read uniformly through `platform().config.get('texra.experimental.goal.enabled', false)` — no direct `vscode.workspace.getConfiguration` or `@utils/config` import in agnostic code paths.

The `goal` tool **is always registered** in `createDefaultTools()` (`src/tools/registry.ts:82–137`) so that `RegisteredToolName = keyof ReturnType<typeof createDefaultTools>` stays compile-time stable. It is consumed by `src/tools/externalToolDefs.ts:18` and `src/tools/toolAvailability.ts:17`; making registration runtime-conditional would break both.

The flag is checked at three runtime points:

1. **Tool execute** — `GoalTool.execute()` short-circuits with a `featureDisabled` error if the flag is off.
2. **Wait-node hook** — continuation injection is skipped (see §5.3 pseudocode) when the flag is off, even if a stale Goal record exists from a prior run.
3. **UI surfaces** — the stream-header toggle button and Settings → Goal tab are hidden when off.

Hosts that don't surface the experimental flag at all simply have it default to `false`; the tool stays inert and no UI appears.

### 5.8 Cross-host portability

Goal must work in three hosts: VS Code extension, Electron desktop, and `@texra/cli` (the CLI). The split is:

| Concern                     | Host-neutral (kernel, all three hosts)                                                                                                                                                                                                                  | Host-specific (per host)                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema (`GoalSchema`)       | `src/tools/goal/goalMeta.ts`                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                                     |
| Store (`GoalStore`)         | `src/tools/goal/goalStore.ts` — uses `platform().workspaceState`                                                                                                                                                                                        | Backing implementation lives in each host's platform-defaults; the kernel never imports it.                                                                                                                                                                           |
| Tool (`GoalTool`)           | `src/tools/goal/GoalTool.ts`                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                                     |
| Continuation prompt YAML    | `packages/extension/resources/goal/goal.yaml` — packaged with each host's resource bundle. The YAML loader resolves the path through the host's already-configured agent-resource pipeline; no `vscode.Uri` calls and no path joining in agnostic code. | —                                                                                                                                                                                                                                                                     |
| Wait-node hook              | `src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts` — single edit, runs in the same shape on every host (`exec()` is host-neutral).                                                                                                      | —                                                                                                                                                                                                                                                                     |
| Feature flag read           | `platform().config.get('texra.experimental.goal.enabled', false)`                                                                                                                                                                                       | Each host declares the key in its own settings schema (`contributes.configuration` for the extension; settings.json + UI tab for the desktop; `[features]` in `~/.texra/config.toml` for the CLI). All three end up read through the same `ConfigProvider` interface. |
| IPC schema                  | `src/shared/schemas/goalViewMessages.ts`                                                                                                                                                                                                                | Each host's message handler routes the same messages: `SettingsViewMessageHandler` in the extension, the desktop's IPC dispatcher, and the CLI's `texra goal` subcommand (Phase 2 — see §9).                                                                          |
| Stream-header button (PR 2) | —                                                                                                                                                                                                                                                       | Extension + desktop only (`packages/extension/src/progressView/frontend/components/StreamHeader.ts`; desktop shares the webview).                                                                                                                                     |
| Settings → Goal tab (PR 2)  | —                                                                                                                                                                                                                                                       | Extension + desktop only.                                                                                                                                                                                                                                             |
| Progress board entry (PR 2) | —                                                                                                                                                                                                                                                       | Extension + desktop only.                                                                                                                                                                                                                                             |
| CLI control surface         | —                                                                                                                                                                                                                                                       | `texra goal start`, `pause`, `resume`, `abandon`, and `status` subcommands (Phase 2). `status` writes to stdout; mutating commands use exit codes and stderr diagnostics. Same IPC schema, same handler.                                                              |

Two PR-1 invariants follow from this split:

1. Every file under `src/agent/`, `src/tools/`, `src/shared/`, and `src/platform/interfaces/` must remain free of `vscode` imports (see CLAUDE.md → "Separation of Concerns: VS Code Coupling"). Storage, config, and FS access go through `platform()`.
2. The YAML prompt bundle resolution must reuse the existing agent-resource lookup — it must not bake `packages/extension/resources/` as an absolute path in agnostic code. The host configures resource roots once at startup.

## 6. File layout

Host-neutral (kernel — used by extension, desktop, and CLI):

```
src/shared/schemas/
  goalViewMessages.ts              NEW
  settingsViewMessages.ts             MODIFY (re-export)

src/tools/goal/
  GoalTool.ts                      NEW
  goalMeta.ts                      NEW  (Zod schemas, constants)
  goalStore.ts                     NEW  (platform().workspaceState wrapper)
  index.ts                            NEW

src/agent/goal/
  buildContinuationFollowUp.ts        NEW  (YAML template render)
  formatGoalTime.ts                NEW  (hour-aware duration formatter)
  maybeBuildGoalContinuation.ts    NEW  (pre-wait continuation check)
  promptLoader.ts                     NEW  (YAML loader + inline fallback)

src/agent/implementations/flows/tooluse/nodes/
  ToolUseWaitNode.ts                  MODIFY (~25 lines in exec())

src/tools/registry.ts                 MODIFY (register GoalTool unconditionally;
                                              gating happens inside GoalTool.execute())

packages/extension/resources/goal/
  goal.yaml                        NEW  (packaged with each host's resource bundle)
```

Extension-host UI (PR 2 — shared with the desktop host via the same webviews):

```
packages/extension/src/settingsView/
  frontend/tabs/GoalTab.ts                          NEW   (PR 2)
  frontend/components/goal/GoalList.ts           NEW   (PR 2)
  frontend/components/goal/GoalEditor.ts         NEW   (PR 2)
  utils/goalFileSystem.ts                           NEW   (PR 2)
  SettingsViewMessageHandler.ts                        MODIFY (PR 2)
  frontend/SettingsApp.ts                              MODIFY (PR 2)
  frontend/tabs/index.ts                               MODIFY (PR 2)

packages/extension/src/progressView/frontend/components/
  StreamHeader.ts                     MODIFY (PR 2)
  constants.ts                        MODIFY (PR 2 — ELEMENT_IDS.GOAL_TOGGLE_BTN)

src/common/webview/commands.ts        MODIFY (PR 2 — settings tab command/schema)

packages/extension/package.json       MODIFY (contributes.configuration entry)
```

CLI host (Phase 2, separate PR — out of scope for PR 1 and PR 2):

```
packages/cli/src/commands/goal/    NEW   (Phase 2)
  start.ts                            — texra goal start "<objective>"
  pause.ts / resume.ts / abandon.ts
  status.ts                           — prints current goal, exit code reflects status

packages/cli/src/config/configSchema  MODIFY (Phase 2 — features.goal field)
```

Desktop host:

```
packages/desktop/                     no new files; reuses the extension webviews and
                                      registers the same IPC handlers through its
                                      existing settings-IPC pipeline.
```

## 7. Phased rollout

**PR 1 — Core mechanism (no rich UI).** Schema, store, GoalTool, wait-node continuation hook in `exec()`, IPC schema, YAML prompt bundle, feature flag declarations (extension + CLI + desktop config schemas), and unconditional tool registration with execute-time gating. Validation: a temporary debug log line + manual `goal { view }` call from the model in dev exercises the loop. No header button, no Settings tab. Host-neutral by construction — every file lives outside the VS Code-allowed zones.

**PR 2 — UI surfaces.** StreamHeader expansion (Row 1 toggle button + Row 2 context band), Settings Goal tab, progress board entry, abandon-on-conversation-delete hook. Pure UI on top of working core.

## 8. Risks and mitigations

| Risk                                                             | Mitigation                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model drifts away from the stated objective over many turns      | Continuation prompt insists on verifying against _current external state_ (Codex's own guardrail). Model has no tool to edit the objective.                                                                            |
| Model never calls `complete`                                     | `maxContinuations` defaults to 50 and pauses the Goal when reached. The user can resume explicitly.                                                                                                                    |
| Token accounting becomes stale and the badge shows wrong numbers | TeXRA already emits usage per response; apply to goal record at the same time as the existing usage event. Off by ≤1 turn in worst case — acceptable for an informational chip.                                        |
| Multi-agent orchestration interferes with continuation           | Hard guard in the wait-node hook: skip continuation injection when `this.services.isSubagent` is true (already checked at `ToolUseWaitNode.ts:56` for a different concern). The parent orchestrator owns continuation. |
| User clears a conversation but the Goal record lingers           | Subscribe to the existing conversation-delete event in PR 2; mark goal `abandoned` and drop from index.                                                                                                                |
| Webview reconnect shows stale goal state                         | State lives in `platform().workspaceState`; the GoalTab and StreamHeader band fetch on mount and on `GOAL_UPDATED` IPC events.                                                                                         |

## 9. Open questions

- Should `start` from the model auto-activate, or require user confirmation? Codex auto-activates. PR 1 ships auto-activate; revisit if it surprises users.
- Should the default `maxContinuations` be 50, or should it be lower for the first experimental release?
- CLI control surface (Phase 2) — see §5.8 for the high-level shape. The `texra goal` subcommands are a separate PR after PR 2; until then, CLI users get the tool-only flow (model can `start`, `pause`, `complete` from inside any tool-use agent run).

## 10. References

- Codex `/goal` user-facing docs: https://developers.openai.com/codex/use-cases/follow-goals
- TeXRA tool pattern reference: `src/tools/memory/MemoryTool.ts` (single tool with `command` enum discriminator).
- TeXRA wait-node integration point: `src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts:39-114`.
