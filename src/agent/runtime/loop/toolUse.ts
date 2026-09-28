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
 * wait (a batch consumed at `turn.ready` runs its turn), an unanswered open
 * attempt invokes again under its gate, a pending response dispatches what
 * is unsettled, and a halted run launched again waits for its input.
 *
 * A workflow agent's run is this loop in round mode (`./rounds`): the same
 * turn, run once per round by the round loop, with no tools and no input.
 */
import { Effect, Exit, type Scope, SynchronizedRef } from 'effect';
import { z } from 'zod';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { FollowUpBatch } from '@agent/followUp/RunInput';
import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { logUserMessage } from '@agent/trace';
import type { ProcessServices } from '@platform/processRuntime';
import { LanguageModel } from '@platform/languageModel';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  AgentCategory,
  RUN_OUTCOME,
  type JsonValue,
  type RetryErrorInfo,
  type RunOutcome,
  type RunUsageTotals,
  SkillCatalogSchema,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { type RunState } from '@shared/session/runStateFold';
import { sha256 } from '@tools/catalogEntries';

import { AgentRun } from '../run/AgentRun';
import { compactIfNeeded } from '../run/compaction';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { blobRows, stored } from '../run/requestContext';
import { toolDefinitionsFor } from '../run/tools';
import { claimFollowUps, type ConsumedFollowUps } from '../FollowUps';
import { ModelInvoker } from '../ModelInvoker';
import { Runs } from '../runRegistry';
import {
  appendRow,
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
import { dispatchPendingResponse } from './toolUseDispatch';
import { stepFor, type RunSystem } from './step';
import { applyPendingModelSwitch, modelSwitchPort } from './modelSwitch';
import { roundLoop, roundsContinuation } from './rounds';
import type { SessionHandle } from '../SessionHandle';
import type { ChildRunTurns } from '../childRunLoop';

const IMMEDIATE_COMPACTION_FOLLOW_UP =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';
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
  /** A native child's turn permit, and the boundary its loop delivers at. */
  readonly turns?: ChildRunTurns<ToolUseResult>;
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
  /** The documents a round-mode run produced, from its rows. */
  readonly roundOutputs: RunState['roundOutputs'];
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
  | WorkspaceFs
  | StorageFs
  | Scope.Scope
> {
  const run = yield* AgentRun;
  const ledger = yield* RunLedger;
  const runs = yield* Runs;
  const invoker = yield* ModelInvoker;
  const languageModel = yield* LanguageModel;
  const { runId, session, logger } = run;
  const isChild = () => (runs.getHandle(runId)?.parent ?? null) !== null;
  // A workflow run is round mode for its whole life; a conversation's
  // continuation is pinned by each step instead.
  const roundPolicy =
    run.config.agentCategory === AgentCategory.Workflow
      ? yield* roundsContinuation(run)
      : null;
  const rounds = roundPolicy?.rounds ?? null;
  // A conversation claims its own input lease, never a parent's (FollowUps).
  const followUps = rounds ? null : yield* claimFollowUps(run, ledger);

  // ---------------------------------------------------------------- state
  let workspace = AgentWorkspaceState.create();
  // Recorded facts a restore reads back (catalog, misses).
  let catalog = run.opening?.catalog ?? [];
  let memoryMisses = run.opening?.attachedMemoryMisses ?? [];
  let systemPrompt: string | undefined;
  let response = '';
  // A `/compact` the host admitted: done at the next model boundary.
  let compactionRequested = false;

  /** The family state every snapshot of this run carries. The instruction
   *  and activated skills are the folded state's: only the transaction that
   *  consumes a delivery changes them. */
  const flowState = (state: RunState): ToolUseFlowState => {
    const { instruction, activated } = state.flow?.state ?? {};
    return {
      stateSlices: {
        workspaceSnapshot: workspace.toSnapshot({
          excludeAssemblyStrings: true,
        }),
      },
      ...(systemPrompt !== undefined ? { system: sha256(systemPrompt) } : {}),
      ...(catalog.length > 0 ? { skills: sha256(catalog) } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      ...(activated !== undefined ? { activated } : {}),
      ...(memoryMisses.length > 0 ? { memoryMisses } : {}),
      ...(run.structured.value !== undefined
        ? { structured: run.structured.value }
        : {}),
    };
  };
  const snapshot = (state: RunState, patch: Omit<SnapshotPatch, 'state'>) =>
    snapshotRow(runId, state, { ...patch, state: flowState(state) });

  const publishTouchedFiles = (): void => {
    const paths = workspace.interactions.toSnapshot().edits.map((e) => e.path);
    if (paths.length === 0) return;
    session.publish([
      { type: 'run.workspaceFiles', aggregateId: rowAggregate(runId), paths },
    ]);
  };

  // A resumed root's first continuation-pinning step stands it down first.
  let resumeUnseen = start.resume;
  // What a step's system text and skill roots are built from.
  const system: RunSystem = {
    base: () => systemPrompt,
    catalog: () => catalog,
    // The opening's before its snapshot records them.
    activated: (state) => {
      if (state.flow === null) return run.opening?.activated ?? [];
      const { activated } = state.flow.state;
      return activated ? stored(state, activated, SkillCatalogSchema) : [];
    },
    isChild,
  };
  const openStep = (state: RunState, kind: 'request' | 'dispatch' | 'park') =>
    Effect.tap(stepFor(run, state, rounds !== null, kind, system), (step) => {
      if (!resumeUnseen || step.continuation === null || isChild())
        return Effect.void;
      resumeUnseen = false;
      return step.continuation
        .onResume({ session, runId })
        .pipe(Effect.provide(step.tools.services));
    });

  // ------------------------------------------------------------ host port
  let live = false;
  const flowContext: ToolUseFlowContext = {
    ownerSession: session,
    interrupt(): void {
      runs.interrupt(runId);
    },
    requestImmediateCompaction(): void {
      compactionRequested = true;
      // A parked loop wakes on a synthetic turn; the compaction runs before
      // that turn's request, and the message tells the model to do nothing.
      if (followUps !== null && !followUps.hasQueued()) {
        followUps.appendSynthetic(IMMEDIATE_COMPACTION_FOLLOW_UP);
      }
    },
    ...modelSwitchPort(run, languageModel),
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

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('toolUse.open')(function* (
    opening: RunState,
  ): Effect.fn.Return<RunState, Error, ProcessServices> {
    // Keep preparation interruptible inside the masked acquire.
    const { bound, content, offered } = yield* Effect.interruptible(
      Effect.gen(function* () {
        const bound = yield* SynchronizedRef.get(run.model);
        // A round-mode run opens with no message and offers no tools. A
        // tool-use run's first step is recorded with its opening.
        if (rounds) return { bound, content: null, offered: [] };
        const { inputs } =
          run.opening ?? (yield* Effect.die(new Error(`${runId}: no opening`)));
        const prompts = yield* buildInitialToolUsePrompts(
          run.prompt,
          inputs,
          logger,
          {
            workspace: session.roots.workspace,
            settings: session.roots,
          },
        );
        systemPrompt = prompts.systemPrompt
          ? `${prompts.systemPrompt}\n${prompts.instructionSuffix}`
          : prompts.instructionSuffix;
        // The first step renders the prompt, and stores its base text.
        const step = yield* openStep(opening, 'request');
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
        workspace = AgentWorkspaceState.create();
        return { bound, content, offered: step.rows };
      }),
    );
    const activated = run.opening?.activated ?? [];
    const opened = yield* ledger.appendBatch(runId, null, [
      ...(content ? [appendRow(runId, [{ role: 'user', content }])] : []),
      ...offered,
      // The catalog is stored once, before the snapshot that names it.
      ...blobRows(
        runId,
        opening,
        [catalog, activated].filter((l) => l.length),
      ),
      snapshotRow(runId, opening, {
        phase: 'initial',
        runtime: {
          modelId: bound.modelId,
          modelCompatibilityKey: bound.compatibilityKey,
        },
        state: {
          ...flowState(opening),
          ...(activated.length > 0 ? { activated: sha256(activated) } : {}),
        },
      }),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return opened;
  });

  const restore = (state: RunState): void => {
    const flow = state.flow?.state;
    if (flow === undefined) {
      throw new Error(`Run ${runId} is not a toolUse run; resume it as one.`);
    }
    if (flow.stateSlices)
      workspace = AgentWorkspaceState.fromSnapshot(
        flow.stateSlices.workspaceSnapshot,
      );
    systemPrompt = flow.system && stored(state, flow.system, z.string());
    catalog = flow.skills ? stored(state, flow.skills, SkillCatalogSchema) : [];
    memoryMisses = flow.memoryMisses ?? [];
    if (flow.structured !== undefined) run.structured.value = flow.structured;
    logger.debug('Resuming tool-use run from the ledger.');
  };

  // ------------------------------------------------------------ the turn
  type TurnExit = { readonly state: RunState; readonly outcome: RunOutcome };
  const runTurn = Effect.fn('toolUse.turn')(function* (
    cell: RunCell,
    /** Round mode: open the next round, closing the completed one. */
    advance = false,
  ): Effect.fn.Return<
    TurnExit,
    Error,
    AgentRun | RunLedger | ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    let state = yield* cell.current;
    // A turn begins at a settled boundary; a resumed one where its rows left.
    const begins =
      advance ||
      state.phase === 'initial' ||
      state.phase === 'waiting' ||
      state.phase === 'halted';
    /** Round mode's round: the turn's own count less one. */
    const index = begins ? state.turn : state.turn - 1;
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
      if (begins) {
        response = '';
        workspace.assembly.lastResponse = '';
        workspace.assembly.accumulatedOutput = '';
        const content = rounds ? yield* rounds.open(index) : null;
        state = yield* cell.append([
          ...(advance ? [stepRow(runId, state, 'turn.end')] : []),
          ...(content ? [appendRow(runId, [{ role: 'user', content }])] : []),
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
          if (rounds) return yield* rounds.afterResponse(at, cell, index, live);
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
            workspace.resetReasoning();
            return { state: next, done: false };
          }
          if (text) {
            workspace.assembly.lastResponse = text;
            if (live) logger.emit({ type: 'response.finalized', text });
          }
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
      // through the same policy, once, when this turn is entered (the rows
      // say so: its step, no open attempt). Treating it as finished would
      // skip the blank-turn continuation and the forced structured output.
      let replayCommitted = true;
      for (;;) {
        state = yield* applyPendingModelSwitch(state, cell, snapshot);
        if (state.pendingResponse !== null) {
          // A user's follow-up to a stopped response joins its delivery.
          const joined = followUps && (yield* followUps.joinStopped(state));
          const dispatched = yield* dispatchPendingResponse(
            cell,
            workspace,
            (yield* openStep(state, 'dispatch')).tools,
            joined,
          );
          state = dispatched.state;
          joined?.delivered();
          if (dispatched.endTurn && !joined) return completeTurn(state);
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
        // The step this request opens, its offered set recorded when changed.
        const step = yield* openStep(state, 'request');
        if (step.rows.length > 0) state = yield* cell.append(step.rows);
        const tools = toolDefinitionsFor(step.tools.definitions);
        // One round: the compaction the history may need, the snapshot that
        // admits the round, then the invocation. An open attempt's history
        // is fixed; it is neither compacted nor re-admitted.
        if (state.openAttempt === null) {
          const force = compactionRequested ? 'request' : null;
          compactionRequested = false;
          // Round mode compacts only on overflow: rounds build on each other.
          if (rounds === null)
            state = yield* cell.adopt(
              yield* compactIfNeeded(state, {
                runId,
                ledger,
                logger,
                bound,
                stores: session.roots,
                system: step.system,
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
          tools,
          toolChoice,
          ...(rounds
            ? yield* rounds.request(index)
            : {
                system: step.system,
                round: state.round,
                debugName: 'tooluse',
              }),
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
      () =>
        rounds?.stage(index) ??
        logger.openStage('Tool-use turn', { kind: 'session' }),
      (exit: TurnExit) => exit.outcome,
    )(body).pipe(
      Effect.ensuring(Effect.sync(() => workspace.workPlan.clearOnUpdate())),
    );
  });

  // ------------------------------------------------------------- the loop
  const enter = Effect.gen(function* () {
    // The follow-ups the rows still queue (input admitted while no consumer
    // held this run, or a batch a crash left unconsumed, C3) are the
    // publisher's, seeded where `loadRun`'s claim moved here.
    const entry = yield* loadRun(runId, start.resume);
    const opened =
      entry._tag === 'fresh'
        ? yield* openFresh(entry.opening)
        : (restore(entry.loaded), entry.loaded);
    return yield* makeRunCell(runId, opened);
  });

  const loopBody = (cell: RunCell) =>
    Effect.gen(function* () {
      if (!followUps) return yield* Effect.die(new Error(`${runId}: no lease`));
      let restoring = start.resume;
      for (;;) {
        let state = yield* cell.current;
        const parked =
          (state.phase === 'waiting' || state.phase === 'halted') &&
          state.step !== 'turn.ready';
        // The invoker commits the run's failure fact and the input that
        // recovers the run clears it, so the fold is the one place to read it.
        const afterError = state.lastError !== null;
        if (parked) {
          // A native child waits in this same run scope, just like its root:
          // its loop has already delivered the turn offered at the boundary.
          if (isChild() && afterError && !followUps.hasQueued())
            return finish(state, RUN_OUTCOME.FAILED);
          // Activation clears the visible step: restore an idle cursor's park.
          if (restoring && !followUps.hasQueued())
            state = yield* cell.append([stepRow(runId, state, 'waiting')]);
          restoring &&= followUps.hasQueued();
          // A child's idle is its parent's; the policy sees failed turns too.
          const canContinue =
            !run.toolPolicy.stopAfterCycle && !followUps.hasQueued();
          // A park opens a step, which pins (and records) its continuation.
          let next: string | null = null;
          if (!isChild()) {
            const step = yield* openStep(state, 'park');
            if (step.rows.length > 0) state = yield* cell.append(step.rows);
            if (step.continuation !== null) {
              next = yield* step.continuation
                .atIdle({ session, runId, state, canContinue })
                .pipe(Effect.provide(step.tools.services));
            }
          }
          // Every park is idle, a failed turn's too: a resume acks the first.
          run.callbacks.onIdle?.();
          if (run.toolPolicy.stopAfterCycle) {
            return finish(
              state,
              afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.COMPLETED,
            );
          }
          // A queued follow-up outranks the policy's synthetic turn.
          let batch: FollowUpBatch | null =
            next !== null && !followUps.hasQueued()
              ? { synthetic: true, text: next }
              : null;
          if (batch === null) {
            // The host port stays attached: `/model`, `/compact` land here.
            batch = yield* followUps.wait;
            if (batch === null) {
              // The queue was cancelled or disposed under the parked loop:
              // a cancellation, never a completed turn.
              return finish(
                state,
                afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.CANCELLED,
              );
            }
          }
          const consumed: ConsumedFollowUps = yield* followUps.consume(
            state,
            batch,
          );
          state = yield* cell.adopt(consumed.state);
          if (!consumed.turn) continue;
        }
        restoring = false;
        const turn: TurnExit = yield* start.turns
          ? start.turns.turnPermit(runTurn(cell))
          : runTurn(cell);
        state = turn.state;
        if (turn.outcome === 'cancelled') {
          return finish(state, RUN_OUTCOME.CANCELLED);
        }
        // The turn's trace rows publish fire-and-forget while the ledger
        // appends here, so the `waiting` row would commit ahead of them and
        // the fold would drop this turn's stream rows, parking a run with no
        // answer in its transcript. Settling this run's publications (by run
        // id: a session-wide settle misses this run's rollback) orders the
        // two paths. Its failure ends the run through the failure path, whose
        // terminal row carries the `artifact-drain` marker while the drain
        // that decides it still finds the lost fact.
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
          yield* start.turns.onTurnBoundary(result(turn.outcome, state));
      }
    });

  /** The terminal step of a run that ends here, then the caller's result. */
  const finish = (state: RunState, outcome: RunOutcome): TurnExit =>
    ({ state, outcome }) as const;

  const result = (outcome: RunOutcome, at: RunState): ToolUseResult => ({
    outcome,
    response,
    files: workspace.interactions.toSnapshot().edits.map((e) => e.path),
    usage: at.usage,
    structured: run.structured.value,
    roundOutputs: at.roundOutputs,
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
        return yield* Effect.acquireUseRelease(
          enter,
          roundPolicy ? roundLoop(roundPolicy, runTurn, snapshot) : loopBody,
          (cell, exit) => settleRun(cell, logger, followUps)(exit),
        );
      }),
    () => Effect.sync(detach),
  ).pipe(
    Effect.map((loop) => result(loop.outcome, loop.state)),
    Effect.catchCause(stoppedBy(logger, `Tool-use run ${runId}`)),
  );
}, Effect.scoped);
