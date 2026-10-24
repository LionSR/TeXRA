/**
 * The tool-use program: one plain Effect loop over the run history, no cursor
 * and no graph. Durable phases are row data; the loop never holds its own
 * copy of the conversation, it continues from the state its run cell folds
 * back from every batch, which makes the live path and the resume path the
 * same function. Every write point below is one `cell.append`.
 *
 * The write points, in order (manifest section 1.2): the opening batch of a
 * fresh run (its message and input, its `run.config` binding, `turn.ready`);
 * `turn.begin`; per round the invoker's `attempt` / `identified` /
 * `response` rows; per barrier call its `tool.intent`; per settled call its
 * `tool.result` with its card; the delivering `append` with the complete
 * tool group; a nudge `append` with its reason; `turn.end` and `waiting`;
 * the follow-up consumption; and the `halted` step at every exit that ends
 * the run.
 *
 * Every branch reads the fold, so the live path and the resume path are the
 * same steps: a `waiting` phase re-enters the wait (a batch consumed at
 * `turn.ready` runs its turn), an unanswered open attempt invokes again
 * under its gate, a pending response dispatches what is unsettled, a
 * committed text response runs its policy, and a halted run launched again
 * waits for its input.
 *
 * A run opened on a script (`AgentConfig.script`: a background script, a
 * task's recipe) opens on that one call, handed down in its opening batch
 * instead of asked of its model; its settlement (`RunState.handedDown`)
 * ends the turn.
 */

import { Effect, Exit, type Scope, SynchronizedRef } from 'effect';

import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { logUserMessage } from '@agent/trace';
import { ModelAccess } from '@agent/runtime/modelAccess/ModelAccess';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';
import { RunHistory, type RunCell } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runState';
import { sentDefinitions } from '@tools/catalogEntries';
import { sha256 } from '@utils/core/idHash';

import { AgentRun } from '../run/AgentRun';
import { backgroundCompaction } from '../run/compaction';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { turnText } from '../run/turnText';
import { claimFollowUps, type ConsumedFollowUps } from '../FollowUps';
import { ModelInvoker } from '../ModelInvoker';
import { registryOf, Runs } from '../runRegistry';
import {
  appendRow,
  configRow,
  consumedRows,
  handedDown,
  finalizedRows,
  positionRow,
} from './rows';
import {
  openRun,
  settleRun,
  stagedBy,
  stoppedBy,
  type RunExit,
} from './runProgram';
import { dispatchPendingResponse } from './toolUseDispatch';
import { openingHooks, stopHooks } from './hooks';
import { stepFor } from './step';
import { applyPendingModelSwitch, modelSwitchPort } from './modelSwitch';
import type { RunControls } from '../RunHandle';
import type { ChildRunBoundary } from '../childRunLoop';
import type { RunEndResult } from '../RunEndResult';

const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';

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
  const isChild = () => runs.parentOf(runId) !== null;
  // A conversation claims its own input lease, never a parent's (FollowUps).
  const followUps = yield* claimFollowUps(run);
  const compaction = yield* backgroundCompaction({
    runId,
    logger,
    invoker,
    stores: session.roots,
  });

  // ---------------------------------------------------------------- state
  // The system text a fresh run renders, until its opening batch records it.
  let openingSystem: string | undefined;
  // The text the turn answers with, reported with its end.
  let response = '';

  const openStep = (state: RunState, kind: 'request' | 'dispatch' | 'park') =>
    stepFor(run, state, kind, isChild(), openingSystem);

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

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('toolUse.open')(function* (
    cell: RunCell,
  ): Effect.fn.Return<RunCell, Error, ProcessServices> {
    const bound = yield* SynchronizedRef.get(run.model);
    // The state its first step opens on: what the opening batch records.
    const { backend } = bound;
    const binding = { backend, declinedRoutes: run.declinedRoutes };
    const opening: RunState = {
      ...(yield* cell.current),
      ...{ modelId: bound.modelId, ...binding },
    };
    // A fork is born on the history it was cut from, its turn ready.
    const { seed } = run.entry;
    if (seed != null) {
      const born = [
        ...seed,
        configRow(runId, run.config, bound.modelId, binding),
        positionRow(runId, opening, 'turn.ready'),
      ];
      yield* cell
        .append(born, run.entry.opening)
        .pipe(Effect.andThen(run.entry.entered), Effect.uninterruptible);
      run.callbacks.onProgress?.({ kind: 'started' });
      return cell;
    }
    // Keep preparation interruptible inside the masked acquire.
    const { content, offered, handed } = yield* Effect.interruptible(
      Effect.gen(function* () {
        // A script's run renders no prompt: what it runs is its call.
        const { script } = run.config;
        if (script != null) {
          const step = yield* openStep(opening, 'request');
          const content: InputPart[] = [
            { kind: 'text', text: `Run the script "${script.title}".` },
          ];
          const handed = [yield* handedDown(run, script)];
          return { content, offered: step.rows, handed };
        }
        const prompts = yield* buildInitialToolUsePrompts(
          run.persona.prompt,
          run.opening ?? (yield* Effect.die(new Error(`${runId}: no opening`))),
          {
            workspace: session.roots.workspace,
            settings: session.roots,
            textOnly: bound.textOnly,
          },
        );
        openingSystem = [prompts.systemPrompt, prompts.instructionSuffix]
          .filter(Boolean)
          .join('\n');
        // The first step renders the prompt, and stores its base text.
        const step = yield* openStep(opening, 'request');
        // The user's task is the user message.
        const userRequest = run.config.instruction.trim();
        if (!userRequest)
          return yield* Effect.fail(
            new Error('A conversation requires a non-empty task.'),
          );
        const content: InputPart[] = [];
        const media = yield* Effect.exit(
          run.config.mediaFiles.length
            ? mediaInputParts(
                run.config.mediaFiles.map((p) =>
                  run.fileService.locateSource(p),
                ),
                bound.config.capabilities,
                logger,
                run.session.roots.config,
              )
            : Effect.succeed({ parts: [], kinds: [] }),
        );
        if (run.entry.initialUserMessage) {
          logUserMessage(logger, run.entry.initialUserMessage, {
            attachments: Exit.isSuccess(media) ? media.value.kinds : [],
          });
        }
        if (Exit.isFailure(media)) return yield* Effect.failCause(media.cause);
        content.push(...media.value.parts, { kind: 'text', text: userRequest });
        const hooked = yield* openingHooks(run, opening, userRequest);
        content.push(...hooked.parts);
        return { content, offered: [...step.rows, ...hooked.rows], handed: [] };
      }),
    );
    const { activated = [], attachedMemoryMisses: misses = [] } =
      run.opening ?? {};
    const input = {
      ...(openingSystem !== undefined && { system: sha256(openingSystem) }),
      ...(activated.length > 0 && { activated: [...activated] }),
      ...(misses.length > 0 && { memoryMisses: misses }),
    };
    // The opening (registration, held trace), then the entry once it
    // settled: a stop lands before the opening or after both.
    const rows = [
      appendRow(runId, [{ role: 'user', content }], { input }),
      ...offered,
      configRow(runId, run.config, bound.modelId, binding),
      positionRow(runId, opening, 'turn.ready'),
      ...handed,
    ];
    yield* cell
      .append(rows, run.entry.opening)
      .pipe(Effect.andThen(run.entry.entered), Effect.uninterruptible);
    run.callbacks.onProgress?.({ kind: 'started' });
    return cell;
  });

  /** A turn's exit, and a handed-down call's run's at its park: a failed
   *  call's error fails it and is the reply. */
  const completeTurn = (at: RunState): RunExit => {
    if (at.handedDown?.status !== 'error')
      return { state: at, outcome: 'completed' };
    response = at.handedDown.error;
    return { state: at, outcome: 'failed' };
  };

  // ------------------------------------------------------------ the turn
  const runTurn = Effect.fn('toolUse.turn')(function* (
    cell: RunCell,
  ): Effect.fn.Return<RunExit, Error, TurnServices> {
    let state = yield* cell.current;
    // A turn begins at a settled boundary; a resumed one where its rows left.
    const begins = state.phase === 'waiting' || state.phase === 'halted';
    const body = Effect.gen(function* () {
      if (begins) {
        response = '';
        state = yield* cell.append([
          positionRow(runId, { ...state, turn: state.turn + 1 }, 'turn.begin'),
        ]);
      }
      /**
       * The policy a committed text-only response runs, read off the rows:
       * a blank turn after a tool result asks once more, the terminal tool
       * gets one forced turn per turn, else the turn ends with this text.
       * Each step is a row, so a resume finds it. `done` ends the turn.
       */
      const afterTextResponse = Effect.fn('toolUse.afterTextResponse')(
        function* (
          at: RunState,
          text: string,
        ): Effect.fn.Return<
          { readonly state: RunState; readonly done: boolean },
          Error,
          AgentRun | RunHistory
        > {
          if (!text.trim() && at.messages.at(-2)?.role === 'tool') {
            const next = yield* cell.append([
              appendRow(runId, [nudge(BLANK_TOOL_RESULT_CONTINUATION)], {
                reason: 'blank-continuation',
              }),
            ]);
            return { state: next, done: false };
          }
          if (text && !at.answerFinalized)
            at = yield* cell.append(finalizedRows(runId, text));
          if (
            run.finalToolName !== null &&
            at.finalToolTurn !== at.turn &&
            at.structured === null
          ) {
            const next = yield* cell.append([
              appendRow(runId, [nudge(FINAL_TOOL_INSTRUCTION)], {
                reason: 'final-tool',
              }),
            ]);
            return { state: next, done: false };
          }
          return { state: at, done: true };
        },
      );
      for (;;) {
        state = yield* applyPendingModelSwitch(
          cell,
          (at) => compaction.settle(at, 'the model is switching'),
          yield* followUps.controls,
        );
        if (state.pendingResponse !== null) {
          // A user's follow-up to a stopped response joins its delivery.
          const joined = yield* followUps.joinStopped(state);
          const dispatched = yield* dispatchPendingResponse(
            cell,
            (yield* openStep(state, 'dispatch')).tools,
            joined,
          );
          state = dispatched.state;
          joined?.delivered();
          if (dispatched.endTurn && !joined) return completeTurn(state);
          continue;
        }
        // A handed-down call asks no model: delivered, the turn ends.
        if (state.handedDown !== null) return completeTurn(state);
        // A committed text-only response whose policy has not run: the
        // response this turn just received, or one a resume finds.
        const last =
          state.at === 'response.ready' && state.invocation === null
            ? state.messages.at(-1)
            : undefined;
        if (last?.role === 'assistant') {
          const text = turnText(last);
          if (text) response = text;
          const processed = yield* afterTextResponse(state, text);
          state = processed.state;
          if (processed.done) return completeTurn(state);
          continue;
        }
        const bound = yield* SynchronizedRef.get(run.model);
        // The step this request opens, its offered set recorded when changed.
        let step = yield* openStep(state, 'request');
        if (step.rows.length > 0) state = yield* cell.append(step.rows);
        let tools = sentDefinitions(step.tools);
        // One round: the compaction the history may need, the `/compact`s
        // it answers, then the invocation. An open attempt's history
        // is fixed; it is neither compacted nor re-admitted.
        if (state.invocation === null) {
          // The queued `/compact`s are consumed by the edit that answers
          // them, or, with nothing to summarize, by this round's admission.
          const controls = yield* followUps.controls;
          const requests = consumedRows(runId, controls, 'compact');
          state = yield* compaction.atBoundary(cell, bound, requests);
          // A compaction replaced the history, the context updates in it
          // too: a new step renders the system text anew, each one in it.
          if (state.offeredContext === null) {
            step = yield* openStep(state, 'request');
            state = yield* cell.append(step.rows);
            tools = sentDefinitions(step.tools);
          }
          const unanswered = (yield* followUps.controls).filter((f) =>
            requests.some(({ followUpId }) => followUpId === f.followUpId),
          );
          const admitted = consumedRows(runId, unanswered, 'compact');
          if (admitted.length > 0) state = yield* cell.append(admitted);
        }
        const toolChoice =
          state.forceFinalTool &&
          run.finalToolName !== null &&
          bound.forcedToolChoice
            ? { name: run.finalToolName }
            : undefined;
        const outcome = yield* invoker.invoke(cell, {
          tools,
          toolChoice,
          system: step.system,
        });
        state = outcome.state;
        if (outcome.kind === 'cancelled') {
          return { state, outcome: 'cancelled' } as const;
        }
        if (outcome.kind === 'failed') {
          return { state, outcome: 'failed' } as const;
        }
        if (outcome.text) response = outcome.text;
      }
    });
    return yield* stagedBy(
      () => logger.openStage('Tool-use turn', { kind: 'session' }),
      (exit: RunExit) => exit.outcome,
    )(body);
  });

  // ------------------------------------------------------------- the loop
  const enter = Effect.gen(function* () {
    const cell = yield* openRun(runId, start.resume);
    const loaded = yield* cell.current;
    if (loaded.phase === null) return yield* openFresh(cell);
    // A parked run answers with its last turn's text (a resumed child's).
    const last = loaded.messages.at(-1);
    if (
      (loaded.phase === 'waiting' || loaded.phase === 'halted') &&
      last?.role === 'assistant'
    )
      response = turnText(last);
    logger.debug('Resuming tool-use run from the run history.');
    return cell;
  });

  const loopBody = (cell: RunCell) =>
    Effect.gen(function* () {
      let restoring = start.resume;
      for (;;) {
        let state = yield* cell.current;
        const parked =
          (state.phase === 'waiting' || state.phase === 'halted') &&
          state.at !== 'turn.ready';
        // The invoker commits the run's failure fact and the input that
        // recovers the run clears it, so the fold is the one place to read it.
        const afterError = state.lastError !== null;
        if (parked) {
          if (state.handedDown !== null) return completeTurn(state);
          // A native child waits in this same run scope, just like its root:
          // its loop has already delivered the turn offered at the boundary.
          const queued = yield* followUps.hasQueued;
          if (isChild() && afterError && !queued)
            return finish(state, RUN_OUTCOME.FAILED);
          // Activation clears the visible step: restore an idle cursor's park.
          if (restoring && !queued)
            state = yield* cell.append([positionRow(runId, state, 'waiting')]);
          restoring &&= queued;
          // A root's wait opens a step, recorded like a request's; a
          // child's idle is its parent's.
          if (!isChild()) {
            const step = yield* openStep(state, 'park');
            if (step.rows.length > 0) state = yield* cell.append(step.rows);
          }
          // Every wait is idle, a failed turn's too: a resume acks the first.
          run.callbacks.onIdle?.();
          if (run.toolPolicy.stopAfterCycle) {
            return finish(
              state,
              afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.COMPLETED,
            );
          }
          // The host port stays attached: `/model`, `/compact` land here.
          const batch = yield* followUps.wait;
          if (batch === null) {
            // The input ended under the waiting loop: a cancellation.
            return finish(
              state,
              afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.CANCELLED,
            );
          }
          const consumed: ConsumedFollowUps = yield* followUps.consume(
            cell,
            batch,
          );
          if (!consumed.turn) continue;
        }
        restoring = false;
        const turn: RunExit = yield* start.turns
          ? start.turns.turnPermit(runTurn(cell))
          : runTurn(cell);
        state = turn.state;
        if (turn.outcome === 'cancelled') {
          return finish(state, RUN_OUTCOME.CANCELLED);
        }
        // A summary the turn started lands before the turn ends.
        state = yield* compaction.finish(cell);
        // The turn's trace rows are queued ahead of the boundary: the
        // barrier lets the open streams `waiting` closes count every one.
        yield* session.log.settled;
        // The turn boundary, in one batch: Stop hooks, the steps (`waiting`
        // closes open streams), a child's turn result with its parent's
        // delivery, and a Stop hook's block or input already queued.
        const { rows: hooks, block } = yield* stopHooks(run, turn, response);
        const goesOn =
          !run.toolPolicy.stopAfterCycle && turn.outcome === 'completed';
        const childTurn =
          start.turns && goesOn && block === null
            ? yield* start.turns.finishTurn(result(turn.outcome, state))
            : null;
        const ending = [
          positionRow(runId, state, 'turn.end'),
          ...session.trace.closure(runId),
          positionRow(runId, state, 'waiting'),
          ...(childTurn?.rows ?? []),
        ];
        const next = block ?? (goesOn ? yield* followUps.takeQueued : null);
        const pin =
          next !== null && !isChild() ? yield* openStep(state, 'park') : null;
        state =
          next === null
            ? yield* cell.append([...hooks, ...ending], childTurn?.alongside)
            : (yield* followUps.consume(cell, next, {
                rows: [...hooks, ...ending, ...(pin?.rows ?? [])],
                alongside: childTurn?.alongside,
              })).state;
        // A turn's end is idle even when it took its next input with it.
        if (next !== null) run.callbacks.onIdle?.();
        if (turn.outcome === 'completed') {
          const cost = state.usage.totalCost;
          run.callbacks.onProgress?.({
            kind: 'overview',
            toolCallCount: state.toolCalls,
            filesChanged: [...state.edited],
            cost: cost > 0 ? cost : undefined,
          });
        }
        if (block !== null) continue;
        // A one-shot run ends with its completed turn; a handed-down call's
        // run ends at its park, however its turn ended.
        if (run.toolPolicy.stopAfterCycle && turn.outcome === 'completed')
          return finish(state, turn.outcome);
        if (childTurn !== null)
          yield* Effect.uninterruptible(childTurn.wakeParent);
      }
    });

  /** A run that ends here: its halt commits with its `run.end`. */
  const finish = (state: RunState, outcome: RunOutcome): RunExit =>
    ({ state, outcome }) as const;

  /** The run's report: what it answered and edited, its spend, its error. */
  const result = (outcome: RunOutcome, at: RunState): RunEndResult => ({
    outcome,
    output: {
      response,
      files: [...at.edited],
      // A recipe's return value, which its block reads (`AgentBlock.result`).
      ...(at.structured?.value !== undefined && {
        structured: at.structured.value,
      }),
    },
    runId,
    usage: at.usage,
    ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
      ? { error: at.lastError }
      : {}),
    ...(at.input.memoryMisses?.length
      ? { memoryMisses: [...at.input.memoryMisses] }
      : {}),
  });

  // Attach inside the outer use so its release detaches even after a partial
  // attach failure. The inner bracket settles the cell before detachment;
  // `cell.append` protects each run history commit from interruption.
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        yield* Effect.sync(attach);
        return yield* Effect.acquireUseRelease(enter, loopBody, (cell, exit) =>
          // However the run ends, a stop's interruption included, a
          // finished summary lands before the halt (its usage is the
          // run's); one still running stops with the run.
          Effect.andThen(
            compaction
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
    Effect.map((loop) => result(loop.outcome, loop.state)),
    Effect.catchCause(stoppedBy(logger, `Tool-use run ${runId}`)),
  );
}, Effect.scoped);
