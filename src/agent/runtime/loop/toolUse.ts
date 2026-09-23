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
import { Effect, Exit, Scope, SynchronizedRef } from 'effect';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { FollowUpBatch } from '@agent/followUp/RunInput';
import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { USER_VAR_INSTRUCTION, USER_VAR_MODEL } from '@agent/prompt/userVars';
import { resolveModelCompatibilityKey } from '@agent/runtime/modelRoutes';
import { logUserMessage } from '@agent/trace';
import {
  getRuntimeModelConfig,
  resolveRuntimeModelConfig,
} from '@model/runtimeModelRegistry';
import type { ProcessServices } from '@platform/processRuntime';
import type { LanguageModel } from '@platform/languageModel';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import {
  RUN_OUTCOME,
  type JsonValue,
  type RetryErrorInfo,
  type RunOutcome,
  type RunUsageTotals,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { type RunState } from '@shared/session/runStateFold';
import { goalOf, pauseGoal, setGoalSessionAutoApproval } from '@tools/goal';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import { AgentRun } from '../run/AgentRun';
import { compactIfNeeded } from '../run/compaction';
import { bindModel, releaseBindingUploads } from '../run/modelBinding';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { toolDefinitionsFor } from '../run/tools';
import { FollowUps, type ConsumedFollowUps } from '../FollowUps';
import { ModelInvoker } from '../ModelInvoker';
import { Runs } from '../runRegistry';
import {
  appendRow,
  familyState,
  rowAggregate,
  snapshotRow,
  stepRow,
  type SnapshotPatch,
  type ToolUseFlowState,
} from './rows';
import {
  loadRun,
  makeRunCell,
  recordServedUsage,
  settleRun,
  stagedBy,
  stoppedBy,
  type RunCell,
} from './runProgram';
import { dispatchPendingResponse, type TurnContext } from './toolUseDispatch';
import type { HttpClient } from 'effect/unstable/http';
import type { SessionHandle } from '../SessionHandle';
import type { ChildRunTurns } from '../childRunLoop';

const IMMEDIATE_COMPACTION_FOLLOW_UP =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';
const MODEL_SWITCH_DIFFERENT_FORMAT_ERROR =
  'Cannot switch this conversation to a model with a different conversation format. Start a new chat to use that model.';
const MODEL_SWITCH_DIFFERENT_FORMAT_REASON =
  'different conversation format; start new chat';
const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';

/** The live control surface a host reaches through the run handle. */
export interface ToolUseFlowContext {
  readonly ownerSession: SessionHandle;
  interrupt(): void;
  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(
    model: string,
  ): Effect.Effect<string | undefined, Error>;
  switchModel(model: string): Effect.Effect<void, Error>;
}

export interface ToolUseStart {
  /** The caller launched this as a resume; the ledger decides what it is. */
  readonly resume: boolean;
  /** Awaited child-turn accounting and delivery, within this run's scope. */
  readonly turns?: ChildRunTurns<ToolUseResult, ProcessServices | Runs>;
  /** Host wiring that is live while the loop can accept an interrupt. */
  readonly attachment?: {
    attach(context: ToolUseFlowContext): void;
    detach(context: ToolUseFlowContext): void;
  };
}

interface ToolUseResult {
  readonly outcome: RunOutcome;
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
  | AgentRun
  | RunLedger
  | ProcessServices
  | Runs
  | ModelInvoker
  | FollowUps
  | WorkspaceFs
  | StorageFs
> {
  const run = yield* AgentRun;
  const ledger = yield* RunLedger;
  const runs = yield* Runs;
  const invoker = yield* ModelInvoker;
  const followUps = yield* FollowUps;
  const { runId, session, logger } = run;
  const isChild = () => runs.getHandle(runId)?.isChild === true;

  // ---------------------------------------------------------------- state
  let workspace = AgentWorkspaceState.create();
  const userChannels: Record<string, unknown> = { ...run.userVarChannels };
  let systemPrompt: string | undefined;
  let response = '';
  // A `/compact` the host admitted: honoured at the next model boundary,
  // regardless of the threshold.
  let compactionRequested = false;

  /** The family state every snapshot of this run carries. */
  const flowState = (): ToolUseFlowState => ({
    stateSlices: {
      workspaceSnapshot: workspace.toSnapshot({
        excludeAssemblyStrings: true,
      }),
      userChannels,
    },
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(run.structured.value !== undefined
      ? { structured: run.structured.value }
      : {}),
  });
  const snapshot = (state: RunState, patch: Omit<SnapshotPatch, 'state'>) =>
    snapshotRow(runId, state, {
      ...patch,
      state: { family: 'toolUse', state: flowState() },
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
    interrupt(): void {
      run.interrupt();
    },
    requestImmediateCompaction(): void {
      compactionRequested = true;
      // A parked loop wakes on a synthetic turn; the compaction runs before
      // that turn's request, and the message tells the model to do nothing.
      if (!followUps.hasQueued()) {
        followUps.appendSynthetic(IMMEDIATE_COMPACTION_FOLLOW_UP);
      }
    },
    modelSwitchDisabledReason: Effect.fn('toolUse.modelSwitchDisabledReason')(
      function* (model: string) {
        const current = SynchronizedRef.getUnsafe(run.model);
        if (current.modelId === model) return undefined;
        const nextConfig = getRuntimeModelConfig(model);
        if (!nextConfig) return `Model ${model} is not registered`;
        const nextKey = yield* resolveModelCompatibilityKey(
          nextConfig,
          run.stores.globalState,
          yield* getUseOpenRouter(run.stores),
        );
        if (!nextKey)
          return `Unsupported model provider: ${nextConfig.provider}`;
        return current.compatibilityKey === nextKey
          ? undefined
          : MODEL_SWITCH_DIFFERENT_FORMAT_REASON;
      },
    ),
    switchModel: Effect.fn('toolUse.switchModel')(function* (model: string) {
      const disabledReason =
        yield* flowContext.modelSwitchDisabledReason(model);
      if (disabledReason !== undefined) {
        return yield* Effect.fail(
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
    }),
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
    function* (
      state: RunState,
      cell: RunCell,
    ): Effect.fn.Return<
      RunState,
      Error,
      LanguageModel | HttpClient.HttpClient
    > {
      const model = run.pendingModelSwitch.value;
      run.pendingModelSwitch.value = null;
      if (model === null) return state;
      const current = yield* SynchronizedRef.get(run.model);
      if (current.modelId === model) return state;
      const nextConfig = yield* resolveRuntimeModelConfig(model);
      if (!nextConfig) {
        return yield* Effect.fail(
          new Error(`Model ${model} is not registered`),
        );
      }
      const next = yield* bindModel({
        config: nextConfig,
        stores: run.stores,
        compatibilityKey: current.compatibilityKey,
        declinedRoutes: state.declinedRoutes,
        agentCategory: run.config.agentCategory,
        temperature: run.setting.temperature,
      }).pipe(Scope.provide(run.scope));
      userChannels[USER_VAR_MODEL] = next.modelId;
      const switched = yield* cell.append([
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
            modelCompatibilityKey: next.compatibilityKey,
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
      yield* releaseBindingUploads(current.model, current.modelId);
      run.callbacks.onModelChanged(next.modelId);
      logger.emit({ type: 'run.config', runId, config: nextAgentConfig });
      return switched;
    },
  );

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('toolUse.open')(function* (
    opening: RunState,
  ): Effect.fn.Return<RunState, Error, ProcessServices> {
    // Keep preparation interruptible inside the masked acquire.
    const { bound, content } = yield* Effect.interruptible(
      Effect.gen(function* () {
        const bound = yield* SynchronizedRef.get(run.model);
        const resolvedToolNames = run.setting.tools.map((tool) => tool.name);
        const promptVars = {
          ...run.userVarChannels,
          [USER_VAR_MODEL]: bound.modelId,
        };
        const prompts = yield* buildInitialToolUsePrompts(
          run.prompt,
          promptVars,
          logger,
          {
            workspace: session.roots.workspace,
            settings: session.roots,
            resolvedToolNames,
            hasDelegationTools: hasDelegationTool(resolvedToolNames),
            isChild: isChild(),
          },
        );
        systemPrompt = prompts.systemPrompt
          ? `${prompts.systemPrompt}\n${prompts.instructionSuffix}`
          : prompts.instructionSuffix;
        const userPrefix = prompts.userPrefix.trim();
        const userRequest = prompts.userRequest.trim();
        if (!userPrefix && !userRequest)
          return yield* Effect.fail(
            new Error(
              'A tool-use run requires a non-empty user prefix or request.',
            ),
          );
        const content: InputPart[] = [];
        if (userPrefix) content.push({ kind: 'text', text: userPrefix });
        const media = yield* Effect.exit(
          run.config.mediaFiles.length
            ? mediaInputParts(
                run.config.mediaFiles.map((p) =>
                  run.fileService.createLocation(p),
                ),
                bound,
                logger,
                run.session.roots.config,
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
        return { bound, content };
      }),
    );
    const opened = yield* ledger.appendBatch(runId, null, [
      appendRow(runId, [{ role: 'user', content }]),
      snapshotRow(runId, opening, {
        phase: 'initial',
        runtime: {
          modelId: bound.modelId,
          modelCompatibilityKey: bound.compatibilityKey,
        },
        state: { family: 'toolUse', state: flowState() },
      }),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return opened;
  });

  const restore = (state: RunState): void => {
    const flow = familyState(state, 'toolUse');
    if (flow === null) {
      throw new Error(`Run ${runId} is not a toolUse run; resume it as one.`);
    }
    if (flow.stateSlices) {
      workspace = AgentWorkspaceState.fromSnapshot(
        flow.stateSlices.workspaceSnapshot,
      );
      Object.assign(userChannels, flow.stateSlices.userChannels);
    }
    systemPrompt = flow.systemPrompt;
    if (flow.structured !== undefined) run.structured.value = flow.structured;
    logger.debug('Resuming tool-use run from the ledger.');
  };

  // ------------------------------------------------------------ the turn
  type TurnExit = {
    readonly state: RunState;
    readonly outcome: 'completed' | 'failed' | 'cancelled';
  };
  type LoopExit = { readonly state: RunState; readonly outcome: RunOutcome };
  const runTurn = Effect.fn('toolUse.turn')(function* (
    cell: RunCell,
  ): Effect.fn.Return<
    TurnExit,
    Error,
    AgentRun | RunLedger | ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    let state = yield* cell.current;
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
        logger.emit({ type: 'run.fact', fact: { key: 'todos', todos } });
        run.callbacks.onProgress?.({ kind: 'todos', todos });
      },
      onPlanUpdate: (plan) => {
        logger.emit({ type: 'run.fact', fact: { key: 'plan', plan } });
        run.callbacks.onProgress?.({ kind: 'plan', plan });
      },
    });
    /** The turn's completed exit; the stage closes with its own verdict. */
    const completeTurn = (at: RunState): TurnExit => ({
      state: at,
      outcome: 'completed',
    });
    const body = Effect.gen(function* () {
      // A turn begins from a settled boundary; a resumed turn continues at
      // whatever phase its rows left.
      if (
        state.phase === 'initial' ||
        state.phase === 'waiting' ||
        state.phase === 'halted'
      ) {
        response = '';
        workspace.assembly.lastResponse = '';
        workspace.assembly.accumulatedOutput = '';
        state = yield* cell.append([
          snapshot(state, { phase: 'model.ready', turn: state.turn + 1 }),
          stepRow(runId, { ...state, turn: state.turn + 1 }, 'turn.begin'),
        ]);
      }
      let forcedTool: string | null = null;
      /**
       * The policy a text-only response runs once it is committed: a blank
       * turn after a tool result asks once more, the terminal tool gets one
       * forced turn, and otherwise the turn ends with this text. `done` is
       * the end of the turn; anything else continues the loop.
       */
      const afterTextResponse = Effect.fn('toolUse.afterTextResponse')(
        function* (
          at: RunState,
          text: string,
          /** A response this turn just received. A recovered one is already
           *  in the transcript its rows were folded from, so replaying it
           *  must not finalize it a second time. */
          live: boolean,
        ): Effect.fn.Return<
          { readonly state: RunState; readonly done: boolean },
          Error,
          | AgentRun
          | RunLedger
          | ProcessServices
          | Runs
          | WorkspaceFs
          | StorageFs
        > {
          let next = at;
          const previous = next.messages.at(-2);
          if (
            !text.trim() &&
            previous?.role === 'tool' &&
            continuedAt !== next.messages.length
          ) {
            continuedAt = next.messages.length;
            next = yield* cell.append([
              appendRow(runId, [
                {
                  role: 'user',
                  content: [
                    { kind: 'text', text: BLANK_TOOL_RESULT_CONTINUATION },
                  ],
                },
              ]),
            ]);
            workspace.resetServerToolContent();
            workspace.resetReasoning();
            return { state: next, done: false };
          }
          if (text) {
            workspace.assembly.lastResponse = text;
            if (live) logger.responseFinalized(text);
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
            next = yield* cell.append([
              appendRow(runId, [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: FINAL_TOOL_INSTRUCTION }],
                },
              ]),
            ]);
            return { state: next, done: false };
          }
          return { state: next, done: true };
        },
      );
      // A committed response whose live post-processing never ran is replayed
      // through the same policy, once, when this turn is entered. The rows
      // say so: the response row moved the step and cleared the attempt, and
      // nothing since has delivered tools or begun another round. Treating it
      // as a finished turn instead would skip the blank-turn continuation and
      // the one forced structured-output attempt, so a crash at that commit
      // boundary could finalize a run with no structured output at all.
      let replayCommitted = true;
      for (;;) {
        state = yield* applyPendingModelSwitch(state, cell);
        if (state.pendingResponse !== null) {
          const dispatched = yield* dispatchPendingResponse(cell, turnContext);
          state = dispatched.state;
          if (dispatched.endTurn) return completeTurn(state);
          continue;
        }
        if (replayCommitted) {
          replayCommitted = false;
          const last =
            state.step === 'response.ready' && state.openAttempt === null
              ? state.messages.at(-1)
              : undefined;
          if (last?.role === 'assistant') {
            const text = last.content
              .flatMap((part) =>
                part.kind === 'message'
                  ? part.content.map((piece) => piece.text)
                  : [],
              )
              .join('');
            if (text) response = text;
            const replayed = yield* afterTextResponse(state, text, false);
            state = replayed.state;
            if (replayed.done) return completeTurn(state);
            continue;
          }
        }
        const bound = yield* SynchronizedRef.get(run.model);
        const tools = toolDefinitionsFor(run.setting.tools);
        // One round: the compaction the history may need, the snapshot that
        // admits the round, then the invocation. An open attempt's history
        // is fixed; it is neither compacted nor re-admitted.
        if (state.openAttempt === null) {
          const force = compactionRequested ? 'request' : null;
          compactionRequested = false;
          state = yield* cell.adopt(
            yield* compactIfNeeded(state, {
              runId,
              ledger,
              logger,
              bound,
              stores: session.roots,
              system: systemPrompt,
              tools,
              force,
            }),
          );
          state = yield* cell.append([
            snapshot(state, { phase: 'model.ready', round: state.round + 1 }),
          ]);
        }
        const toolChoice =
          forcedTool !== null && bound.supportsForcedToolChoice
            ? { name: forcedTool }
            : undefined;
        forcedTool = null;
        const outcome = yield* invoker.invoke(cell, {
          system: systemPrompt,
          tools,
          toolChoice,
          round: state.round,
          debugName: 'tooluse',
        });
        state = outcome.state;
        if (outcome.kind === 'cancelled') {
          return { state, outcome: 'cancelled' } as const;
        }
        if (outcome.kind === 'failed') {
          return { state, outcome: 'failed' } as const;
        }
        yield* recordServedUsage(run, state, outcome.usage);
        if (outcome.text) response = outcome.text;
        if (state.pendingResponse !== null) continue;
        // A text-only response: the same policy the resume path replays.
        const processed = yield* afterTextResponse(state, outcome.text, true);
        state = processed.state;
        if (!processed.done) continue;
        return completeTurn(state);
      }
    });
    return yield* stagedBy(
      () => logger.openStage('Tool-use turn', { kind: 'session' }),
      (exit: TurnExit) => exit.outcome,
    )(body).pipe(
      Effect.ensuring(Effect.sync(() => workspace.workPlan.clearOnUpdate())),
    );
  });

  const pauseActiveGoal = Effect.fn('toolUse.pauseGoal')(function* () {
    if (goalOf(session, runId)?.status !== 'active') return;
    yield* pauseGoal(session, runId);
    setGoalSessionAutoApproval(session, runId, false);
  });

  // ------------------------------------------------------------- the loop
  const enter = Effect.gen(function* () {
    const entry = yield* loadRun(runId, 'toolUse', start.resume);
    // The follow-ups the rows still queue: input admitted while no consumer
    // held this run, or a batch a crash left unconsumed (C3). An unopened
    // aggregate (`phase` null) still carries those rows; seed them before
    // the opening batch so a restart delivers the SQLite copy.
    followUps.seed(entry.loaded);
    const opened =
      entry._tag === 'fresh'
        ? yield* openFresh(entry.opening)
        : (restore(entry.loaded), entry.loaded);
    return yield* makeRunCell(runId, opened);
  });

  const loopBody = (cell: RunCell) =>
    Effect.gen(function* () {
      let restoring = start.resume;
      for (;;) {
        let state = yield* cell.current;
        const parked = state.phase === 'waiting' || state.phase === 'halted';
        // The invoker commits the run's failure fact and the input that
        // recovers the run clears it, so the fold is the one place to read it.
        const afterError = state.lastError !== null;
        if (parked) {
          // A native child waits in this same run scope, just like its root.
          // Its delivery callback has already committed the preceding turn.
          if (isChild() && afterError && !followUps.hasQueued())
            return finish(state, RUN_OUTCOME.FAILED);
          // Activation clears the visible step. Restore an already idle cursor
          // before acknowledging it; no new model turn is needed to park it.
          if (restoring && !followUps.hasQueued()) {
            state = yield* cell.append([stepRow(runId, state, 'waiting')]);
          }
          let batch: FollowUpBatch | null = null;
          if (batch === null) {
            if (afterError && !isChild()) yield* pauseActiveGoal();
            // Every park is idle, a failed turn's included: a resume
            // acknowledges at the first one.
            run.callbacks.onIdle?.(state);
            if (run.toolPolicy.stopAfterCycle) {
              return finish(
                state,
                afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.COMPLETED,
              );
            }
            if (!isChild() && !afterError && !followUps.hasQueued()) {
              const continuation = yield* maybeBuildGoalContinuation(
                session,
                runId,
              );
              if (continuation && !followUps.hasQueued()) {
                batch = { synthetic: true, text: continuation };
              }
            }
          }
          if (batch === null) {
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
          const consumed: ConsumedFollowUps = yield* followUps.consume(
            state,
            batch,
          );
          state = yield* cell.adopt(consumed.state);
          if (consumed.instruction !== undefined) {
            userChannels[USER_VAR_INSTRUCTION] = consumed.instruction;
          }
        }
        restoring = false;
        const turn: TurnExit = yield* start.turns
          ? start.turns.run(runTurn(cell))
          : runTurn(cell);
        state = turn.state;
        if (turn.outcome === 'cancelled') {
          return finish(state, RUN_OUTCOME.CANCELLED);
        }
        // The turn's trace rows publish fire-and-forget while the ledger
        // appends on this fiber, so the parking row would commit ahead of
        // them: the transcript boundary closes on `waiting`, and this turn's
        // `stream.start`/`stream.end`/`response.finalized` are then dropped by
        // the fold, leaving a parked run whose transcript holds no assistant
        // answer. Settling this run's publications here is the order between
        // the two paths, and the run id is what makes it a barrier: a
        // session-wide settle reports session-scoped failures only, so a
        // rolled-back transcript of this run would return successfully here and
        // park the run over it. It observes rather than answers: the failure it
        // throws ends the run through the loop's failure path, and the terminal
        // row that path writes is the one that has to carry the
        // `artifact-drain` marker, which it can only do while the drain that
        // decides it still finds the lost fact.
        yield* session.settlePublications(runId, { consume: false });
        // The turn boundary: the snapshot precedes the steps in one batch, so
        // a viewer cut at either step sees the fields, and a stop between the
        // turn and its wait cannot leave the turn unended. The `waiting` step
        // parks the run (one run model, 3.3), so the streaming rows still open
        // close in its batch: a parked transcript never streams. The invoker
        // owns `lastError`; this snapshot does not restate it.
        state = yield* cell.append([
          snapshot(state, { phase: 'waiting' }),
          stepRow(runId, state, 'turn.end'),
          ...session.streamClosureFacts(runId),
          stepRow(runId, state, 'waiting'),
        ]);
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
        if (run.toolPolicy.stopAfterCycle && turn.outcome === 'completed')
          return finish(state, turn.outcome);
        if (turn.outcome === 'failed') continue;
        if (start.turns)
          yield* start.turns.complete(result(turn.outcome, state));
      }
    });

  /** The terminal step of a run that ends here, then the caller's result. */
  const finish = (state: RunState, outcome: RunOutcome): LoopExit =>
    ({ state, outcome }) as const;

  const result = (outcome: RunOutcome, at: RunState): ToolUseResult => ({
    outcome,
    response,
    files: workspace.interactions.toSnapshot().edits.map((e) => e.path),
    usage: at.usage,
    structured: run.structured.value,
    ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
      ? { error: at.lastError }
      : {}),
  });

  // Attach inside the outer use so its release detaches even after a partial
  // attach failure. The inner bracket settles the cell before detachment;
  // `cell.append` protects each ledger commit from interruption.
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        yield* Effect.sync(attach);
        return yield* Effect.acquireUseRelease(enter, loopBody, (cell, exit) =>
          settleRun(cell, logger, followUps)(exit),
        );
      }),
    () => Effect.sync(detach),
  ).pipe(
    Effect.map((loop) => result(loop.outcome, loop.state)),
    Effect.catchCause(stoppedBy(logger, `Tool-use run ${runId}`)),
  );
});
