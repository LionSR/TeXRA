/**
 * The tool-use program: one plain Effect loop over the run history, no cursor
 * and no graph. Durable phases are row data; the loop never holds its own
 * copy of the conversation, it continues from the state its run cell folds
 * back from every batch, which makes the live path and the resume path the
 * same function. Every write point below is one `cell.append`.
 *
 * The write points, in order: the opening batch of a fresh run (its message
 * and input, its `run.config` binding, `turn.ready`); `turn.begin`; per
 * round the invoker's `attempt` / `identified` / `response` rows; per
 * barrier call its `tool.intent`; per settled call its `tool.result` with
 * its card; the delivering `append` with the complete tool group; a
 * follow-up consumed at a request or a nudge, each an `append`; `turn.end`
 * and `waiting`; the follow-up consumption; and the `halted` step at every
 * exit that ends the run. Every branch reads the fold: a `waiting` phase
 * re-enters the wait (a batch consumed at `turn.ready` runs its turn), an
 * unanswered open attempt invokes again under its gate, a pending response
 * dispatches what is unsettled, a committed text response runs its policy,
 * and a halted run launched again waits for its input.
 *
 * A run opened on a script (`AgentConfig.script`: a background script, a
 * task's recipe) opens on that one call, handed down in its opening batch
 * instead of asked of its model; its settlement (`RunState.handedDown`)
 * ends the turn.
 */

import { Effect, type Scope, SynchronizedRef } from 'effect';

import type { FollowUpBatch } from '@agent/followUp/RunInput';
import { ModelAccess } from '@agent/runtime/modelAccess/ModelAccess';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';
import { RunHistory, type RunCell } from '@shared/session/runHistory';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import type { Alongside } from '@shared/session/sessionEvents';
import { sentDefinitions } from '@tools/catalogEntries';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import {
  backgroundCompaction,
  type BackgroundCompaction,
} from '../run/compaction';
import { turnText } from '../run/turnText';
import { claimFollowUps, type FollowUps } from '../FollowUps';
import { ModelInvoker } from '../ModelInvoker';
import { registryOf, Runs } from '../runRegistry';
import { appendRow, consumedRows, finalizedRows, positionRow } from './rows';
import {
  openFresh,
  openRun,
  settleRun,
  stagedBy,
  stoppedBy,
  type RunExit,
} from './runProgram';
import { dispatchPendingResponse } from './toolUseDispatch';
import { stopHooks } from './hooks';
import { stepFor } from './step';
import { applyPendingModelSwitch, modelSwitchPort } from './modelSwitch';
import type { RunControls } from '../RunHandle';
import type { ChildRunBoundary } from '../childRunLoop';
import type { RunEndResult } from '../RunEndResult';

const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';

/** How a launch starts the tool-use program (`runToolUse`). */
export interface ToolUseStart {
  /** The caller launched this as a resume; the run history decides what it is. */
  readonly resume: boolean;
  /** A native child's turn permit, and the turn result its boundary commits. */
  readonly turns?: ChildRunBoundary<RunEndResult>;
  /** Host wiring that is live while the loop can accept an interrupt. */
  readonly attachment?: {
    attach(controls: RunControls): void;
    detach(controls: RunControls): void;
  };
}

/** A user message the loop appends itself. */
const nudge = (text: string) => ({
  role: 'user' as const,
  content: [{ kind: 'text' as const, text }],
});

/** What a turn of the loop reads from its run's context. */
type TurnServices =
  | AgentRun
  | RunHistory
  | ProcessServices
  | Runs
  | ModelAccess
  | WorkspaceFs
  | StorageFs;

/** One run of the loop: what its turns and waits share. */
interface Loop {
  readonly run: AgentRunShape;
  readonly start: ToolUseStart;
  /** The run's own input (`claimFollowUps`). */
  readonly followUps: FollowUps;
  readonly compaction: BackgroundCompaction;
  /** Whether the run has a parent now: a detach cuts it. */
  readonly isChild: () => boolean;
  /** The text the turn answers with, reported with its end. */
  response: string;
  /** A resumed run that has not restored its idle position yet. */
  restoring: boolean;
}

/**
 * The policy a committed text-only response runs, read off the rows:
 * a blank turn after a tool result (a message delivered at the request
 * may sit between them) asks once more, the terminal tool gets one
 * forced turn per turn, else the turn ends with this text. Each step
 * is a row, so a resume finds it. `done` ends the turn.
 */
const afterTextResponse = Effect.fn('toolUse.afterTextResponse')(function* (
  cell: RunCell,
  at: RunState,
  text: string,
): Effect.fn.Return<
  { readonly state: RunState; readonly done: boolean },
  Error,
  AgentRun | RunHistory
> {
  const { runId, finalToolName } = yield* AgentRun;
  if (
    !text.trim() &&
    at.messages.slice(0, -1).findLast((m) => m.role !== 'user')?.role === 'tool'
  ) {
    const row = appendRow(runId, [nudge(BLANK_TOOL_RESULT_CONTINUATION)], {
      reason: 'blank-continuation',
    });
    return { state: yield* cell.append([row]), done: false };
  }
  if (text && !at.answerFinalized)
    at = yield* cell.append(finalizedRows(runId, text));
  if (
    finalToolName !== null &&
    at.finalToolTurn !== at.turn &&
    at.structured === null
  ) {
    const row = appendRow(runId, [nudge(FINAL_TOOL_INSTRUCTION)], {
      reason: 'final-tool',
    });
    return { state: yield* cell.append([row]), done: false };
  }
  return { state: at, done: true };
});

/** A turn's exit, and a handed-down call's run's at its park: a failed
 *  call's error fails it and is the reply. */
const completeTurn = (loop: Loop, at: RunState): RunExit => {
  if (at.handedDown?.status !== 'error')
    return { state: at, outcome: 'completed' };
  loop.response = at.handedDown.error;
  return { state: at, outcome: 'failed' };
};

/**
 * One request of a turn: a message typed meanwhile joins it, its step opens,
 * the compaction the history may need runs with the `/compact`s it answers,
 * and the model is invoked. `outcome` is set when the invocation ended the
 * turn.
 */
const request = Effect.fn('toolUse.request')(function* (
  loop: Loop,
  cell: RunCell,
  at: RunState,
): Effect.fn.Return<
  { readonly state: RunState; readonly outcome: 'cancelled' | 'failed' | null },
  Error,
  TurnServices | ModelInvoker
> {
  const { run, followUps, compaction } = loop;
  const invoker = yield* ModelInvoker;
  let state = at;
  const bound = yield* SynchronizedRef.get(run.model);
  // A message typed while the turn ran joins the request after the tool
  // results (past a context update), never a user message: read before
  // the step opens, so a skill it activates is the step's, and before a
  // summary lands, which keeps what the loop appended after its base.
  const tail = state.messages.findLast((m) => m.role !== 'system');
  if (state.invocation === null && tail?.role === 'tool') {
    const queued = yield* followUps.read('request');
    if (queued !== null)
      state = (yield* followUps.consume(cell, queued, {
        position: false,
      })).state;
  }
  // The step this request opens, its offered set recorded when changed.
  let step = yield* stepFor(run, state, 'request', loop.isChild());
  if (step.rows.length > 0) state = yield* cell.append(step.rows);
  let tools = sentDefinitions(step.tools);
  // One round: the compaction the history may need, the `/compact`s
  // it answers, the invocation. An open attempt's history is fixed.
  if (state.invocation === null) {
    // A `/compact`: consumed by the edit answering it, else admitted here.
    const controls = yield* followUps.controls;
    const requests = consumedRows(run.runId, controls, 'compact');
    state = yield* compaction.atBoundary(cell, bound, requests);
    // A compaction dropped the context updates: a new step renders them.
    if (state.offeredContext === null) {
      step = yield* stepFor(run, state, 'request', loop.isChild());
      state = yield* cell.append(step.rows);
      tools = sentDefinitions(step.tools);
    }
    const unanswered = (yield* followUps.controls).filter((f) =>
      requests.some(({ followUpId }) => followUpId === f.followUpId),
    );
    const admitted = consumedRows(run.runId, unanswered, 'compact');
    if (admitted.length > 0) state = yield* cell.append(admitted);
  }
  const toolChoice =
    state.forceFinalTool && run.finalToolName !== null && bound.forcedToolChoice
      ? { name: run.finalToolName }
      : undefined;
  const outcome = yield* invoker.invoke(cell, {
    tools,
    toolChoice,
    system: step.system,
  });
  if (outcome.kind === 'cancelled' || outcome.kind === 'failed')
    return { state: outcome.state, outcome: outcome.kind };
  if (outcome.text) loop.response = outcome.text;
  return { state: outcome.state, outcome: null };
});

/**
 * One turn, from a settled boundary (a resumed one from where its rows left
 * it) to its exit. Each round applies a queued model switch, then
 * dispatches a pending response, ends a handed-down call's turn, runs a
 * committed text response's policy, or makes the next request.
 */
const runTurn = Effect.fn('toolUse.turn')(function* (
  loop: Loop,
  cell: RunCell,
): Effect.fn.Return<RunExit, Error, TurnServices | ModelInvoker> {
  const { run, followUps, compaction } = loop;
  let state = yield* cell.current;
  // A turn begins at a settled boundary; a resumed one where its rows left.
  const begins = state.phase === 'waiting' || state.phase === 'halted';
  const body = Effect.gen(function* () {
    if (begins) {
      loop.response = '';
      state = yield* cell.append([
        positionRow(
          run.runId,
          { ...state, turn: state.turn + 1 },
          'turn.begin',
        ),
      ]);
    }
    for (;;) {
      state = yield* applyPendingModelSwitch(
        cell,
        (at) => compaction.settle(at, 'the model is switching'),
        yield* followUps.controls,
      );
      if (state.pendingResponse !== null) {
        // Input queued meanwhile is delivered at the request that follows.
        const dispatched = yield* dispatchPendingResponse(
          cell,
          (yield* stepFor(run, state, 'dispatch', loop.isChild())).tools,
          followUps.controls,
        );
        state = dispatched.state;
        if (dispatched.endTurn) return completeTurn(loop, state);
        continue;
      }
      // A handed-down call asks no model: delivered, the turn ends.
      if (state.handedDown !== null) return completeTurn(loop, state);
      // A committed text-only response whose policy has not run: the
      // response this turn just received, or one a resume finds.
      const last =
        state.at === 'response.ready' && state.invocation === null
          ? state.messages.at(-1)
          : undefined;
      if (last?.role === 'assistant') {
        const text = turnText(last);
        if (text) loop.response = text;
        const processed = yield* afterTextResponse(cell, state, text);
        state = processed.state;
        if (processed.done) return completeTurn(loop, state);
        continue;
      }
      const round = yield* request(loop, cell, state);
      state = round.state;
      if (round.outcome !== null)
        return { state, outcome: round.outcome } as const;
    }
  });
  return yield* stagedBy(
    () => run.logger.openStage('Tool-use turn', { kind: 'session' }),
    (exit: RunExit) => exit.outcome,
  )(body);
});

/**
 * A parked run's wait. A one-shot run ends at its park, and so does a failed
 * child with nothing queued. Otherwise it waits for its next input: `'turn'`
 * when the input it consumed opens a turn, `'wait'` when it waits again; an
 * input that ended cancels the run.
 */
const park = Effect.fn('toolUse.park')(function* (
  loop: Loop,
  cell: RunCell,
  at: RunState,
): Effect.fn.Return<RunExit | 'turn' | 'wait', Error, TurnServices> {
  const { run, followUps } = loop;
  let state = at;
  // The invoker commits the run's failure fact and the input that
  // recovers the run clears it, so the fold is the one place to read it.
  const afterError = state.lastError !== null;
  // A native child waits in this same run scope, just like its root:
  // its loop has already delivered the turn offered at the boundary.
  const queued = yield* followUps.hasPending('idle');
  if (loop.isChild() && afterError && !queued)
    return { state, outcome: RUN_OUTCOME.FAILED };
  // Activation clears the visible step: restore an idle cursor's park.
  if (loop.restoring && !queued)
    state = yield* cell.append([positionRow(run.runId, state, 'waiting')]);
  loop.restoring &&= queued;
  // A root's wait opens a step, recorded like a request's; a
  // child's idle is its parent's.
  if (!loop.isChild()) {
    const step = yield* stepFor(run, state, 'park', loop.isChild());
    if (step.rows.length > 0) state = yield* cell.append(step.rows);
  }
  // Every wait is idle, a failed turn's too: a resume acks the first.
  run.callbacks.onIdle?.();
  if (run.toolPolicy.stopAfterCycle) {
    return {
      state,
      outcome: afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.COMPLETED,
    };
  }
  // The host port stays attached: `/model`, `/compact` land here.
  const batch = yield* followUps.next('idle');
  if (batch === null) {
    // The input ended under the waiting loop: a cancellation.
    return {
      state,
      outcome: afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.CANCELLED,
    };
  }
  const consumed = yield* followUps.consume(cell, batch);
  return consumed.turn ? 'turn' : 'wait';
});

/** Commit a turn's boundary `batch`, taking its next input (`next`) with
 *  it, and the step a root's wait opens when it does. */
const commitBoundary = Effect.fn('toolUse.commitBoundary')(function* (
  loop: Loop,
  cell: RunCell,
  state: RunState,
  next: FollowUpBatch | null,
  batch: { rows: RunHistoryDraft[]; alongside: Alongside<Error> | undefined },
): Effect.fn.Return<RunState, Error, TurnServices> {
  if (next === null) return yield* cell.append(batch.rows, batch.alongside);
  const pin = loop.isChild()
    ? null
    : yield* stepFor(loop.run, state, 'park', loop.isChild());
  const rows = [...batch.rows, ...(pin?.rows ?? [])];
  const consumed = yield* loop.followUps.consume(cell, next, {
    rows,
    alongside: batch.alongside,
  });
  return consumed.state;
});

/** Tell the host a turn ended: idle when it took its next input with it
 *  (`tookInput`; a wait reports its own), and a completed turn's overview. */
const reportBoundary = (
  run: AgentRunShape,
  state: RunState,
  tookInput: boolean,
  completed: boolean,
): void => {
  // A turn's end is idle even when it took its next input with it.
  if (tookInput) run.callbacks.onIdle?.();
  if (!completed) return;
  const cost = state.usage.totalCost;
  run.callbacks.onProgress?.({
    kind: 'overview',
    toolCallCount: state.toolCalls,
    filesChanged: [...state.edited],
    cost: cost > 0 ? cost : undefined,
  });
};

/**
 * The boundary after a turn that was not cancelled, in one batch: Stop
 * hooks, the steps (`waiting` closes open streams), a child's turn result
 * with its parent's delivery, and a Stop hook's block or input already
 * queued. Answers the run's exit when the run ends here, else null.
 */
const endTurn = Effect.fn('toolUse.endTurn')(function* (
  loop: Loop,
  cell: RunCell,
  turn: RunExit,
): Effect.fn.Return<RunExit | null, Error, TurnServices> {
  const { run, start, followUps } = loop;
  const { runId, session } = run;
  // A summary the turn started lands before the turn ends.
  let state = yield* loop.compaction.finish(cell);
  // The turn's trace rows are queued ahead of the boundary: the
  // barrier lets the open streams `waiting` closes count every one.
  yield* session.log.settled;
  const { rows: hooks, block } = yield* stopHooks(run, turn, loop.response);
  const goesOn = !run.toolPolicy.stopAfterCycle && turn.outcome === 'completed';
  const childTurn =
    start.turns && goesOn && block === null
      ? yield* start.turns.finishTurn(result(loop, turn.outcome, state))
      : null;
  const ending = [
    positionRow(runId, state, 'turn.end'),
    ...session.trace.closure(runId),
    positionRow(runId, state, 'waiting'),
    ...(childTurn?.rows ?? []),
  ];
  const next = block ?? (goesOn ? yield* followUps.read('turn') : null);
  state = yield* commitBoundary(loop, cell, state, next, {
    rows: [...hooks, ...ending],
    alongside: childTurn?.alongside,
  });
  reportBoundary(run, state, next !== null, turn.outcome === 'completed');
  if (block !== null) return null;
  // A one-shot run ends with its completed turn; a handed-down call's
  // run ends at its park, however its turn ended.
  if (run.toolPolicy.stopAfterCycle && turn.outcome === 'completed')
    return { state, outcome: turn.outcome };
  if (childTurn !== null) yield* Effect.uninterruptible(childTurn.wakeParent);
  return null;
});

/** The loop: a parked run waits for its input, then each turn runs to its
 *  boundary, until the run ends. A run that ends here halts with its
 *  `run.end`. */
const loopBody = (loop: Loop, cell: RunCell) =>
  Effect.gen(function* () {
    for (;;) {
      const state = yield* cell.current;
      const parked =
        (state.phase === 'waiting' || state.phase === 'halted') &&
        state.at !== 'turn.ready';
      if (parked) {
        if (state.handedDown !== null) return completeTurn(loop, state);
        const waited = yield* park(loop, cell, state);
        if (waited === 'wait') continue;
        if (waited !== 'turn') return waited;
      }
      loop.restoring = false;
      const turn: RunExit = yield* loop.start.turns
        ? loop.start.turns.turnPermit(runTurn(loop, cell))
        : runTurn(loop, cell);
      if (turn.outcome === 'cancelled')
        return { state: turn.state, outcome: RUN_OUTCOME.CANCELLED };
      const ended = yield* endTurn(loop, cell, turn);
      if (ended !== null) return ended;
    }
  });

/** The run's report: what it answered and edited, its spend, its error. */
const result = (
  loop: Loop,
  outcome: RunOutcome,
  at: RunState,
): RunEndResult => ({
  outcome,
  output: {
    response: loop.response,
    files: [...at.edited],
    // A recipe's return value, which its block reads (`AgentBlock.result`).
    ...(at.structured?.value !== undefined && {
      structured: at.structured.value,
    }),
  },
  runId: loop.run.runId,
  usage: at.usage,
  ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
    ? { error: at.lastError }
    : {}),
  ...(at.input.memoryMisses?.length
    ? { memoryMisses: [...at.input.memoryMisses] }
    : {}),
});

/**
 * Run the tool-use program for the run in context, fresh or resumed
 * (`start`), until it ends: the report its `run.end` carries.
 */
export const runToolUse = Effect.fn('toolUse.run')(function* (
  start: ToolUseStart,
): Effect.fn.Return<
  RunEndResult,
  Error,
  TurnServices | ModelInvoker | Scope.Scope
> {
  const run = yield* AgentRun;
  const runs = registryOf(yield* Runs);
  const invoker = yield* ModelInvoker;
  const access = yield* ModelAccess;
  const { runId, session, logger } = run;
  // A conversation claims its own input lease, never a parent's (FollowUps).
  const followUps = yield* claimFollowUps(run);
  const loop: Loop = {
    run,
    start,
    followUps,
    compaction: yield* backgroundCompaction({
      runId,
      logger,
      invoker,
      stores: session.roots,
    }),
    isChild: () => runs.parentOf(runId) !== null,
    response: '',
    restoring: start.resume,
  };

  // ------------------------------------------------------------ host port
  let live = false;
  const controls: RunControls = {
    oneShot: run.toolPolicy.stopAfterCycle === true,
    ...modelSwitchPort(run, access),
  };
  const attach = (): void => {
    if (live) return;
    live = true;
    start.attachment?.attach(controls);
  };
  const detach = (): void => {
    if (!live) return;
    live = false;
    start.attachment?.detach(controls);
  };

  const enter = Effect.gen(function* () {
    const cell = yield* openRun(runId, start.resume);
    const loaded = yield* cell.current;
    if (loaded.phase === null) return yield* openFresh(cell, loop.isChild);
    // A parked run answers with its last turn's text (a resumed child's).
    const last = loaded.messages.at(-1);
    if (
      (loaded.phase === 'waiting' || loaded.phase === 'halted') &&
      last?.role === 'assistant'
    )
      loop.response = turnText(last);
    logger.debug('Resuming tool-use run from the run history.');
    return cell;
  });

  // Attach inside the outer use so its release detaches even after a partial
  // attach failure. The inner bracket settles the cell before detachment;
  // `cell.append` protects each run history commit from interruption.
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        yield* Effect.sync(attach);
        return yield* Effect.acquireUseRelease(
          enter,
          (cell) => loopBody(loop, cell),
          (cell, exit) =>
            // However the run ends, a stop's interruption included, a
            // finished summary lands before the halt (its usage is the
            // run's); one still running stops with the run.
            Effect.andThen(
              loop.compaction
                .settle(cell, 'the run stopped')
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      logger.warn(
                        'A finished background compaction could not be recorded as the run stopped',
                        { data: error },
                      ),
                    ),
                  ),
                ),
              settleRun(cell, followUps)(exit),
            ),
        );
      }),
    () => Effect.sync(detach),
  ).pipe(
    Effect.map((exit) => result(loop, exit.outcome, exit.state)),
    Effect.catchCause(stoppedBy(logger, `Tool-use run ${runId}`)),
  );
}, Effect.scoped);
