/**
 * The tool-use program: one plain Effect loop over the run ledger, no cursor
 * and no graph. Durable phases are row data; the loop never holds its own
 * copy of the conversation, it continues from the state every `appendBatch`
 * returns, which is what makes the live path and the resume path the same
 * function.
 *
 * The write points, in order (manifest section 1.2): the opening batch of a
 * fresh run (initial message, `flow.snapshot`); `turn.begin`; per round the
 * invoker's `attempt` / `identified` / `response` rows; per barrier call its
 * `tool.intent`; per settled call its `tool.result` with its card; the
 * delivering `append` with the complete tool group; `turn.end` and `waiting`
 * with the snapshot that precedes them; the follow-up consumption; and the
 * `halted` step at every exit that ends the run.
 *
 * Resume reads only row data off the fold: a `waiting` phase re-enters the
 * wait, an open attempt without a response invokes again under its gate, a
 * pending response dispatches what is unsettled, and a halted run that is
 * launched again waits for the input that resumes it.
 */
import { Cause, Effect, Exit, Ref, SynchronizedRef } from 'effect';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { USER_VAR_INSTRUCTION, USER_VAR_MODEL } from '@agent/prompt/userVars';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import {
  activeModelHandlerCompatibilityKey,
  resolveModelHandlerCompatibilityKey,
} from '@agent/runtime/ModelFactory';
import { supersedeLegacyFlowRecord } from '@agent/storage/resumability';
import { logUserMessage } from '@agent/trace';
import type { RunUsageTotals } from '@agent/core/usage/RunUsageAccumulator';
import {
  getRuntimeModelConfig,
  resolveRuntimeModelConfig,
} from '@model/runtimeModelRegistry';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import {
  AgentRunStateSnapshotSchema,
  RUN_OUTCOME,
  RUN_PHASE,
  type JsonValue,
  type NormalizedUsage,
  type RetryErrorInfo,
  type RunOutcome,
} from '@shared/schemas';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { GoalStore, setGoalSessionAutoApproval } from '@tools/goal';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun, RunHalted } from '../run/AgentRun';
import { bindModel, type BoundModel } from '../run/modelBinding';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { toolDefinitionsFor } from '../run/tools';
import { FollowUps, type ConsumedFollowUps } from '../FollowUps';
import { ModelInvoker, turnText } from '../ModelInvoker';
import {
  appendRow,
  haltedStepRow,
  rowAggregate,
  snapshotRow,
  stepRow,
  toolUseFlowState,
  type ToolUseFlowState,
} from './rows';
import { dispatchPendingResponse, type TurnContext } from './toolUseDispatch';
import type { SessionHandle } from '../SessionHandle';

const IMMEDIATE_COMPACTION_FOLLOW_UP =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';
const MODEL_SWITCH_DIFFERENT_FORMAT_ERROR =
  'Cannot switch this conversation to a model with a different conversation format. Start a new chat to use that model.';
const MODEL_SWITCH_DIFFERENT_FORMAT_REASON =
  'different conversation format; start new chat';
const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';
const NOT_RESUMABLE_MESSAGE =
  'This run was recorded before the run ledger and is not resumable under this release. Start a new run instead.';

/** The live control surface a host reaches through the run handle. */
export interface ToolUseFlowContext {
  readonly ownerSession: SessionHandle;
  readonly modelHandler: { readonly supportsManualCompaction: boolean };
  interrupt(): void;
  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
}

export interface ToolUseStart {
  /** The caller launched this as a resume; the ledger decides what it is. */
  readonly resume: boolean;
  /** One batch already drained by an external child-turn owner. */
  readonly drainedFollowUps?: readonly FollowUpQueueBatchItem[];
  /** Take messages queued at a resume ownership boundary. */
  readonly takePendingFollowUps?: () => readonly FollowUpQueueBatchItem[];
  /** Host wiring that is live while the loop can accept an interrupt. */
  readonly attachment?: {
    attach(context: ToolUseFlowContext): void;
    detach(context: ToolUseFlowContext): void;
  };
}

export interface ToolUseResult {
  readonly outcome: RunOutcome | typeof RUN_PHASE.WAITING;
  readonly response: string;
  /** Workspace-relative paths of files edited by tool calls. */
  readonly files: readonly string[];
  readonly usage: RunUsageTotals;
  readonly structured: JsonValue | undefined;
  readonly error?: RetryErrorInfo;
}

export const runToolUse = Effect.fn('toolUse.run')(function* (
  start: ToolUseStart,
): Effect.fn.Return<
  ToolUseResult,
  Error,
  AgentRun | RunLedger | ModelInvoker | FollowUps
> {
  const run = yield* AgentRun;
  const ledger = yield* RunLedger;
  const invoker = yield* ModelInvoker;
  const followUps = yield* FollowUps;
  const { runId, session, logger } = run;
  const isChild = run.parentRunId !== null;

  // ---------------------------------------------------------------- state
  // The latest folded state, for the halt finalizer and the host controls.
  const latest = yield* Ref.make<RunState | null>(null);
  const commit = (state: RunState) =>
    Ref.set(latest, state).pipe(Effect.as(state));
  let workspace = AgentWorkspaceState.create();
  const userChannels: Record<string, unknown> = { ...run.userVarChannels };
  let systemPrompt: string | undefined;
  let totalResponseTimeMs = 0;
  let response = '';
  let lastError: RetryErrorInfo | undefined;

  const flowState = (state: RunState): ToolUseFlowState => {
    const previous = toolUseFlowState(state);
    return {
      modelId: state.modelId ?? previous?.modelId,
      ...(state.modelHandlerCompatibilityKey === null
        ? {}
        : { modelHandlerCompatibilityKey: state.modelHandlerCompatibilityKey }),
      shouldSkipCycle: false,
      stateSlices: {
        runStateSnapshot: {
          totalRounds: state.round,
          totalResponseTimeMs,
        },
        workspaceSnapshot: workspace.toSnapshot({
          excludeAssemblyStrings: true,
        }),
        userChannels,
      },
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(run.structured.value !== undefined
        ? { structured: run.structured.value }
        : {}),
    };
  };
  /**
   * Every snapshot names the run's error fact, so the value `restore` reads
   * back (`state.lastError`, the fold's runtime field) is the value the live
   * loop holds: a failed turn resumes as failed, and a follow-up that
   * recovers the run clears it for good.
   */
  const snapshot = (
    state: RunState,
    patch: Omit<Parameters<typeof snapshotRow>[2], 'state'>,
  ) =>
    snapshotRow(runId, state, {
      ...patch,
      runtime: { lastError: lastError ?? null, ...patch.runtime },
      state: flowState(state),
    });

  const publishTouchedFiles = (): void => {
    const paths = workspace.interactions.toSnapshot().edits.map((e) => e.path);
    if (paths.length === 0) return;
    session.publish([
      { type: 'run.workspaceFiles', aggregateId: rowAggregate(runId), paths },
    ]);
  };

  // ------------------------------------------------------------ host port
  let live = false;
  const flowContext: ToolUseFlowContext = {
    ownerSession: session,
    modelHandler: { supportsManualCompaction: false },
    interrupt(): void {
      run.interrupt();
      session.interactions.cancel({ runId, cause: 'Run interrupted.' });
      followUps.interrupt('clear');
    },
    requestImmediateCompaction(): void {
      if (!followUps.hasQueued()) {
        followUps.appendSynthetic(IMMEDIATE_COMPACTION_FOLLOW_UP);
      }
    },
    modelSwitchDisabledReason(model: string): string | undefined {
      const current = SynchronizedRef.getUnsafe(run.model);
      if (current.modelId === model) return undefined;
      const nextConfig = getRuntimeModelConfig(model);
      if (!nextConfig) return `Model ${model} is not registered`;
      const nextKey = resolveModelHandlerCompatibilityKey(
        nextConfig,
        run.stores.globalState,
      );
      if (!nextKey) return `Unsupported model provider: ${nextConfig.provider}`;
      return current.compatibilityKey === nextKey
        ? undefined
        : MODEL_SWITCH_DIFFERENT_FORMAT_REASON;
    },
    switchModel(model: string): Promise<void> {
      const disabledReason = flowContext.modelSwitchDisabledReason(model);
      if (disabledReason !== undefined) {
        return Promise.reject(
          new Error(
            disabledReason === MODEL_SWITCH_DIFFERENT_FORMAT_REASON
              ? MODEL_SWITCH_DIFFERENT_FORMAT_ERROR
              : disabledReason,
          ),
        );
      }
      // Bound and recorded by the loop at its next model boundary: the rows
      // that record the switch belong to the fiber holding the run's state.
      run.pendingModelSwitch.value = model;
      return Promise.resolve();
    },
  };
  const attach = (): void => {
    if (live) return;
    live = true;
    start.attachment?.attach(flowContext);
  };
  const detach = (): void => {
    if (!live) return;
    live = false;
    start.attachment?.detach(flowContext);
  };

  /** Record a host-admitted model switch: the compaction that drops the
   *  continuation, the snapshot naming the new model, then the live swap. */
  const applyPendingModelSwitch = Effect.fn('toolUse.applyModelSwitch')(
    function* (state: RunState): Effect.fn.Return<RunState, Error> {
      const model = run.pendingModelSwitch.value;
      run.pendingModelSwitch.value = null;
      if (model === null) return state;
      const current = yield* SynchronizedRef.get(run.model);
      if (current.modelId === model) return state;
      const nextConfig = yield* Effect.tryPromise({
        try: () => run.inScope(() => resolveRuntimeModelConfig(model)),
        catch: ensureError,
      });
      if (!nextConfig) {
        return yield* Effect.fail(
          new Error(`Model ${model} is not registered`),
        );
      }
      const next = yield* bindModel({
        config: nextConfig,
        stores: run.stores,
        compatibilityKey: current.compatibilityKey,
        agentCategory: run.config.agentCategory,
        temperature: run.setting.temperature,
        inScope: run.inScope,
      });
      userChannels[USER_VAR_MODEL] = next.modelId;
      const switched = yield* ledger.appendBatch(runId, state, [
        {
          type: 'model.compaction',
          aggregateId: rowAggregate(runId),
          payload: {
            keepPrefix: state.messages.length,
            messages: [],
            cause: 'model-switch',
            continuation: null,
            continuationDropped:
              state.continuation === null ? null : 'history-replaced',
          },
        },
        snapshot(state, {
          phase: state.phase ?? 'model.ready',
          runtime: {
            modelId: next.modelId,
            modelHandlerCompatibilityKey: next.compatibilityKey,
          },
        }),
      ]);
      const nextAgentConfig = { ...run.config, model: next.modelId };
      session.publish([
        {
          type: 'run.record',
          aggregateId: rowAggregate(runId),
          record: nextAgentConfig,
        },
      ]);
      yield* SynchronizedRef.set(run.model, next);
      run.callbacks.onModelChanged(next.modelId);
      logger.emit({ type: 'run.config', runId, config: nextAgentConfig });
      return yield* commit(switched);
    },
  );

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('toolUse.open')(function* (): Effect.fn.Return<
    RunState,
    Error
  > {
    yield* supersedeLegacyFlowRecord(runId, session, logger);
    const bound = yield* SynchronizedRef.get(run.model);
    const resolvedToolNames = run.setting.tools.map((tool) => tool.name);
    const promptVars = {
      ...run.userVarChannels,
      [USER_VAR_MODEL]: bound.modelId,
    };
    const prompts = yield* Effect.tryPromise({
      try: () =>
        run.inScope(() =>
          buildInitialToolUsePrompts(run.prompt, promptVars, logger, {
            resolvedToolNames,
            hasDelegationTools: hasDelegationTool(resolvedToolNames),
            isSubagent: isChild,
          }),
        ),
      catch: ensureError,
    });
    systemPrompt = prompts.systemPrompt
      ? `${prompts.systemPrompt}\n${prompts.instructionSuffix}`
      : prompts.instructionSuffix;
    const userPrefix = prompts.userPrefix.trim();
    const userRequest = prompts.userRequest.trim();
    if (!userPrefix && !userRequest) {
      return yield* Effect.fail(
        new Error(
          'A tool-use run requires a non-empty user prefix or request.',
        ),
      );
    }
    const content: InputPart[] = [];
    if (userPrefix) content.push({ kind: 'text', text: userPrefix });
    // Attached media (CLI `--media`, an image pasted on the first message)
    // rides the initial user message; the transcript's opening row logs
    // whether or not the attachment succeeds.
    const media = yield* Effect.exit(
      run.config.mediaFiles.length
        ? mediaInputParts(
            run.inScope(() =>
              run.config.mediaFiles.map((p) =>
                run.fileService.createLocation(p),
              ),
            ),
            bound,
            logger,
            run.inScope,
          )
        : Effect.succeed({ parts: [], kinds: [] }),
    );
    if (run.initialUserMessageForTranscript) {
      logUserMessage(
        logger,
        run.initialUserMessageForTranscript,
        Exit.isSuccess(media) ? media.value.kinds : [],
      );
    }
    if (Exit.isFailure(media)) return yield* Effect.failCause(media.cause);
    content.push(...media.value.parts);
    if (userRequest) content.push({ kind: 'text', text: userRequest });
    userChannels[USER_VAR_MODEL] = bound.modelId;
    workspace = AgentWorkspaceState.create();
    const opened = yield* ledger.appendBatch(runId, null, [
      appendRow(runId, [{ role: 'user', content }]),
      snapshotRow(runId, fresh(bound), {
        phase: 'initial',
        runtime: {
          modelId: bound.modelId,
          modelHandlerCompatibilityKey: bound.compatibilityKey,
        },
        state: flowState(fresh(bound)),
      }),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return yield* commit(opened);
  });

  /** The state a fresh run's opening snapshot is authored against. */
  const fresh = (bound: BoundModel): RunState => ({
    commit: 0,
    snapshotCommit: null,
    rowsBeforeSnapshot: 0,
    family: 'toolUse',
    step: null,
    outcome: null,
    phase: null,
    round: 0,
    turn: 0,
    continuationIndex: 0,
    modelId: bound.modelId,
    modelHandlerCompatibilityKey: bound.compatibilityKey,
    lastError: null,
    pendingRetry: null,
    messages: [],
    continuation: null,
    openAttempt: null,
    lastTurn: null,
    pendingResponse: null,
    pendingIntents: {},
    approvals: {},
    usage: AgentRunStateSnapshotSchema.parse({}).usageAccumulator.totals,
    flow: null,
  });

  const restore = (state: RunState): void => {
    const flow = toolUseFlowState(state);
    if (flow === null) return;
    if (flow.stateSlices) {
      workspace = AgentWorkspaceState.fromSnapshot(
        flow.stateSlices.workspaceSnapshot,
      );
      Object.assign(userChannels, flow.stateSlices.userChannels);
      totalResponseTimeMs =
        flow.stateSlices.runStateSnapshot.totalResponseTimeMs;
    }
    systemPrompt = flow.systemPrompt;
    lastError = state.lastError ?? undefined;
    if (flow.structured !== undefined) run.structured.value = flow.structured;
    logger.debug('Resuming tool-use run from the ledger.');
  };

  // ------------------------------------------------------------ the turn
  type TurnExit = {
    readonly state: RunState;
    readonly outcome: 'completed' | 'failed' | 'cancelled';
  };
  type LoopExit =
    | { readonly state: RunState; readonly waiting: true }
    | {
        readonly state: RunState;
        readonly waiting: false;
        readonly outcome: RunOutcome;
      };
  const usageSnapshot = (
    state: RunState,
    latestUsage: NormalizedUsage | null,
  ) =>
    AgentRunStateSnapshotSchema.parse({
      totalRounds: state.round,
      totalResponseTimeMs,
      usageAccumulator: { totals: state.usage, latestUsage },
    });

  const runTurn = Effect.fn('toolUse.turn')(function* (
    initial: RunState,
  ): Effect.fn.Return<TurnExit, Error, AgentRun | RunLedger> {
    let state = initial;
    const turnContext: TurnContext = {
      workspace,
      get userInstruction() {
        const instruction = userChannels[USER_VAR_INSTRUCTION];
        return typeof instruction === 'string' ? instruction : undefined;
      },
    };
    let continuedAt: number | null = null;
    let finalToolAttempted = false;
    workspace.workPlan.setOnUpdate({
      onTodosUpdate: (todos) => {
        emitRunFact(logger, 'updateTodos', { todos });
        run.callbacks.onProgress?.({ kind: 'todos', todos });
      },
      onPlanUpdate: (plan) => {
        emitRunFact(logger, 'updatePlan', { plan });
        run.callbacks.onProgress?.({ kind: 'plan', plan });
      },
    });
    const stage = logger.openStage('Tool-use turn', { kind: 'session' });
    let stageOutcome: RunOutcome = RUN_OUTCOME.FAILED;
    try {
      // A turn begins from a settled boundary; a resumed turn continues at
      // whatever phase its rows left.
      if (
        state.phase === 'initial' ||
        state.phase === 'waiting' ||
        state.phase === 'halted'
      ) {
        workspace.assembly.lastResponse = '';
        workspace.assembly.accumulatedOutput = '';
        state = yield* commit(
          yield* ledger.appendBatch(runId, state, [
            snapshot(state, { phase: 'model.ready', turn: state.turn + 1 }),
            stepRow(runId, { ...state, turn: state.turn + 1 }, 'turn.begin'),
          ]),
        );
      }
      let forcedTool: string | null = null;
      for (;;) {
        state = yield* applyPendingModelSwitch(state);
        if (state.pendingResponse !== null) {
          const dispatched = yield* dispatchPendingResponse(state, turnContext);
          state = yield* commit(dispatched.state);
          if (dispatched.endTurn) {
            stageOutcome = RUN_OUTCOME.COMPLETED;
            return { state, outcome: 'completed' };
          }
          continue;
        }
        if (state.phase === 'response.ready' && state.openAttempt === null) {
          // A completed text response that was never processed: the turn it
          // ended is over. The assistant message is already in history.
          const last = state.messages.at(-1);
          if (last?.role === 'assistant') {
            response = last.content
              .flatMap((part) =>
                part.kind === 'message'
                  ? part.content.map((piece) => piece.text)
                  : [],
              )
              .join('');
          }
          stageOutcome = RUN_OUTCOME.COMPLETED;
          return { state, outcome: 'completed' };
        }
        // One round: the snapshot that admits it, then the invocation.
        if (state.openAttempt === null) {
          state = yield* commit(
            yield* ledger.appendBatch(runId, state, [
              snapshot(state, { phase: 'model.ready', round: state.round + 1 }),
            ]),
          );
        }
        const bound = yield* SynchronizedRef.get(run.model);
        const toolChoice =
          forcedTool !== null && bound.supportsForcedToolChoice
            ? { name: forcedTool }
            : undefined;
        forcedTool = null;
        const outcome = yield* invoker.invoke(state, {
          system: systemPrompt,
          tools: toolDefinitionsFor(run.setting.tools),
          toolChoice,
          round: state.round,
          debugName: 'tooluse',
        });
        state = yield* commit(outcome.state);
        if (outcome.kind === 'cancelled') {
          stageOutcome = RUN_OUTCOME.CANCELLED;
          return { state, outcome: 'cancelled' };
        }
        if (outcome.kind === 'failed') {
          lastError = outcome.error;
          return { state, outcome: 'failed' };
        }
        lastError = undefined;
        totalResponseTimeMs += outcome.responseTimeMs;
        yield* Effect.tryPromise({
          try: () =>
            run.inScope(() =>
              run.usageMonitor.recordUsage(usageSnapshot(state, outcome.usage)),
            ),
          catch: ensureError,
        });
        if (outcome.text) response = outcome.text;
        if (state.pendingResponse !== null) continue;
        // A text-only response. A blank turn after a tool result asks once
        // more; the terminal tool gets one forced turn; otherwise the turn
        // ends with this text.
        const previous = state.messages.at(-2);
        const blankAfterToolResult =
          !outcome.text.trim() && previous?.role === 'tool';
        if (blankAfterToolResult && continuedAt !== state.messages.length) {
          continuedAt = state.messages.length;
          state = yield* commit(
            yield* ledger.appendBatch(runId, state, [
              appendRow(runId, [
                {
                  role: 'user',
                  content: [
                    { kind: 'text', text: BLANK_TOOL_RESULT_CONTINUATION },
                  ],
                },
              ]),
            ]),
          );
          workspace.resetServerToolContent();
          workspace.resetReasoning();
          continue;
        }
        if (outcome.text) {
          workspace.assembly.lastResponse = outcome.text;
          logger.responseFinalized(outcome.text);
        }
        workspace.resetServerToolContent();
        workspace.resetReasoning();
        if (
          run.finalToolName !== null &&
          !finalToolAttempted &&
          run.structured.value === undefined
        ) {
          finalToolAttempted = true;
          forcedTool = run.finalToolName;
          state = yield* commit(
            yield* ledger.appendBatch(runId, state, [
              appendRow(runId, [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: FINAL_TOOL_INSTRUCTION }],
                },
              ]),
            ]),
          );
          continue;
        }
        stageOutcome = RUN_OUTCOME.COMPLETED;
        return { state, outcome: 'completed' };
      }
    } finally {
      stage.end(stageOutcome);
      workspace.workPlan.clearOnUpdate();
    }
  });

  const pauseActiveGoal = Effect.fn('toolUse.pauseGoal')(function* () {
    const goal = run.inScope(() => GoalStore.getForRun(runId));
    if (goal?.status !== 'active') return;
    yield* Effect.tryPromise({
      try: () =>
        run.inScope(async () => {
          await GoalStore.setStatus(runId, 'paused');
          await setGoalSessionAutoApproval(runId, false, { session });
        }),
      catch: ensureError,
    });
  });

  // ------------------------------------------------------------- the loop
  const program = Effect.gen(function* () {
    attach();
    const pendingBatches: FollowUpQueueBatchItem[] = [
      ...(start.drainedFollowUps ?? []),
      ...(start.takePendingFollowUps?.() ?? []),
    ];
    if (start.resume) yield* ledger.acquire(runId);
    const loaded = yield* ledger.load(runId);
    let state: RunState;
    if (loaded === null) {
      if (start.resume) {
        return yield* Effect.fail(new Error(NOT_RESUMABLE_MESSAGE));
      }
      state = yield* openFresh();
    } else {
      if (!start.resume && loaded.phase !== null) {
        // A fresh launch onto a non-empty aggregate is refused (#11313).
        return yield* Effect.fail(
          new Error(
            `Run ${runId} already has ledger state; resume it instead.`,
          ),
        );
      }
      state = loaded;
      restore(state);
      yield* Ref.set(latest, state);
    }

    for (;;) {
      const parked =
        state.phase === 'waiting' ||
        state.phase === 'halted' ||
        (state.phase === 'response.ready' &&
          state.openAttempt === null &&
          state.pendingResponse === null &&
          state.step === 'waiting');
      const afterError = lastError !== undefined;
      if (parked || state.phase === 'initial') {
        if (state.phase !== 'initial') {
          // Input for the next turn: a batch in hand, else what the queue
          // holds, else (root only) a blocking wait.
          let batch =
            pendingBatches.length > 0
              ? { items: pendingBatches.splice(0), synthetic: false }
              : null;
          if (batch === null && isChild) {
            if (afterError) return finish(state, RUN_OUTCOME.FAILED);
            // A one-cycle launch stops here rather than suspending: the
            // headless in-band child has no orchestrator to resume it, so a
            // WAITING park would leave the run hanging.
            if (run.toolPolicy.stopAfterCycle) {
              return finish(state, RUN_OUTCOME.COMPLETED);
            }
            batch = yield* followUps.drain;
            if (batch === null) {
              session.status.transitionToWaiting(runId, 'wait');
              return { state, waiting: true } as const satisfies LoopExit;
            }
          }
          if (batch === null) {
            if (afterError) {
              yield* pauseActiveGoal();
            } else {
              run.callbacks.onIdle?.();
            }
            if (run.toolPolicy.stopAfterCycle) {
              return finish(
                state,
                afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.COMPLETED,
              );
            }
            if (!afterError && !followUps.hasQueued()) {
              const continuation = yield* Effect.tryPromise({
                try: () => run.inScope(() => maybeBuildGoalContinuation(runId)),
                catch: ensureError,
              });
              if (continuation && !followUps.hasQueued()) {
                batch = {
                  items: [{ text: continuation, origin: 'synthetic' as const }],
                  synthetic: true,
                };
              }
            }
          }
          if (batch === null) {
            if (!followUps.hasQueued()) {
              session.status.transitionToWaiting(runId, 'wait');
            }
            detach();
            batch = yield* followUps.wait;
            if (batch === null) {
              // The queue was cancelled or disposed under the parked loop:
              // a cancellation, never a completed turn.
              return finish(
                state,
                afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.CANCELLED,
              );
            }
            attach();
          }
          session.status.transition(runId, RUN_PHASE.RUNNING, 'resume');
          const consumed: ConsumedFollowUps = yield* followUps.consume(
            state,
            batch,
          );
          state = yield* commit(consumed.state);
          if (consumed.instruction !== undefined) {
            userChannels[USER_VAR_INSTRUCTION] = consumed.instruction;
          }
          lastError = undefined;
        }
      }
      const turn: TurnExit = yield* runTurn(state);
      state = turn.state;
      if (turn.outcome === 'cancelled') {
        return finish(state, RUN_OUTCOME.CANCELLED);
      }
      // The turn boundary: the snapshot precedes the steps in one batch, so
      // a viewer cut at either step sees the fields, and a stop between the
      // turn and its wait cannot leave the turn unended.
      state = yield* commit(
        yield* ledger.appendBatch(runId, state, [
          snapshot(state, { phase: 'waiting' }),
          stepRow(runId, state, 'turn.end'),
          stepRow(runId, state, 'waiting'),
        ]),
      );
      publishTouchedFiles();
      if (turn.outcome === 'completed') {
        const interactions = workspace.interactions;
        const cost = state.usage.totalCost;
        run.callbacks.onProgress?.({
          kind: 'overview',
          toolCallCount: interactions.toolCallCount,
          filesChanged: interactions.editedFilePaths,
          cost: cost > 0 ? cost : undefined,
        });
      }
      if (
        isChild &&
        turn.outcome === 'completed' &&
        pendingBatches.length === 0
      ) {
        // One child cycle per invocation: the child loop delivers this
        // turn's facts and owns the next wait.
        session.status.transitionToWaiting(runId, 'wait');
        return { state, waiting: true } as const satisfies LoopExit;
      }
    }
  });

  /** The terminal step of a run that ends here, then the caller's result. */
  const finish = (state: RunState, outcome: RunOutcome): LoopExit =>
    ({ state, waiting: false, outcome }) as const;

  const result = (
    outcome: RunOutcome | typeof RUN_PHASE.WAITING,
    at: RunState | null,
  ): ToolUseResult => ({
    outcome,
    response,
    files: workspace.interactions.toSnapshot().edits.map((e) => e.path),
    usage:
      at?.usage ??
      AgentRunStateSnapshotSchema.parse({}).usageAccumulator.totals,
    structured: run.structured.value,
    ...(lastError !== undefined && outcome === RUN_OUTCOME.FAILED
      ? { error: lastError }
      : {}),
  });

  /**
   * The exit protocol: the halt row and the lease release happen whether the
   * loop returned, failed, or was interrupted by a host stop. It hangs off
   * `onExit` rather than an `Effect.exit` followed by a masked block — an
   * external interrupt unwinds straight past `Effect.exit`, which left the
   * `halted` step unwritten and the follow-up lease held, so a same-process
   * resume refused the run.
   */
  const finalize = (exit: Exit.Exit<LoopExit, Error>) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const state = yield* Ref.get(latest);
        // Every exit that ends the run writes its `halted` step; the state a
        // stop interrupted stays at the phase its rows left, so resume
        // continues it.
        const halt = (outcome: RunOutcome) =>
          state === null || state.phase === null
            ? Effect.void
            : ledger
                .appendBatch(runId, state, [
                  haltedStepRow(runId, state, outcome),
                ])
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      logger.warn('Failed to record the run halt', {
                        data: error,
                      }),
                    ),
                  ),
                );
        const release = (next: 'recoverable' | 'terminal') =>
          Effect.sync(() => {
            detach();
            followUps.release(
              next === 'recoverable' || session.runs.hasActiveChildren(runId)
                ? 'recoverable'
                : 'terminal',
            );
          });
        if (Exit.isSuccess(exit)) {
          if (exit.value.waiting) return yield* release('recoverable');
          const outcome = exit.value.outcome;
          yield* halt(outcome);
          return yield* release(
            outcome === RUN_OUTCOME.COMPLETED ? 'terminal' : 'recoverable',
          );
        }
        if (Cause.hasInterrupts(exit.cause)) {
          yield* halt(RUN_OUTCOME.CANCELLED);
          return yield* release('recoverable');
        }
        yield* halt(RUN_OUTCOME.FAILED);
        yield* release('recoverable');
      }),
    );

  /** The caller's error for a run that ended in a failure cause. */
  const failure = (error: unknown): Error => {
    if (error instanceof RunLedgerRefused) {
      return new Error(
        `The run ledger refused a write (${error.reason}): ${error.detail}`,
        { cause: error },
      );
    }
    if (error instanceof RunHalted) {
      return new Error(error.error?.message ?? `Run ${error.outcome}`, {
        cause: error,
      });
    }
    return ensureError(error);
  };

  return yield* program.pipe(
    Effect.onExit(finalize),
    Effect.map((loop) =>
      loop.waiting
        ? result(RUN_PHASE.WAITING, loop.state)
        : result(loop.outcome, loop.state),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const stopped = failure(Cause.squash(cause));
      logger.warn(`Tool-use run ${runId} stopped: ${stopped.message}`);
      return Effect.fail(stopped);
    }),
  );
});
