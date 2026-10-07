/**
 * The tool-use program: one plain Effect loop over the run history, no cursor
 * and no graph. Durable phases are row data; the loop never holds its own
 * copy of the conversation, it continues from the state every `appendBatch`
 * returns, which makes the live path and the resume path the same function.
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
 * document task's recipe) makes that one call instead of asking its model
 * and ends when it settles.
 */

import { Deferred, Effect, Exit, type Scope, SynchronizedRef } from 'effect';
import { z } from 'zod';

import type { FollowUpBatch } from '@agent/followUp/RunInput';
import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { logUserMessage } from '@agent/trace';
import type { ProcessServices } from '@platform/processRuntime';
import { LanguageModel } from '@platform/languageModel';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  RUN_OUTCOME,
  type AttachedMemoryMiss,
  type JsonValue,
  type RetryErrorInfo,
  type RunOutcome,
  type RunUsageTotals,
} from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runStateFold';
import { toolDefinitionsFor } from '@tools/catalogEntries';
import { sha256 } from '@utils/core/idHash';

import { AgentRun } from '../run/AgentRun';
import { backgroundCompaction } from '../run/compaction';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { stored } from '../run/requestContext';
import { claimFollowUps, type ConsumedFollowUps } from '../FollowUps';
import { ModelInvoker } from '../ModelInvoker';
import { Runs } from '../runRegistry';
import {
  appendRow,
  configRow,
  consumedRows,
  handedDown,
  positionRow,
  scriptSettlement,
} from './rows';
import {
  loadRun,
  makeRunCell,
  settleRun,
  stagedBy,
  stoppedBy,
  type RunCell,
  type RunExit,
} from './runProgram';
import { dispatchPendingResponse } from './toolUseDispatch';
import { openingHooks, stopHooks } from './hooks';
import { stepFor, type RunSystem } from './step';
import { applyPendingModelSwitch, modelSwitchPort } from './modelSwitch';
import type { RunControls } from '../RunHandle';
import type { ChildRunBoundary } from '../childRunLoop';

const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';

/** The text an assistant message answers with. */
const answerOf = (
  message: Extract<RunState['messages'][number], { role: 'assistant' }>,
): string =>
  message.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');

export interface ToolUseStart {
  /** The caller launched this as a resume; the run history decides what it is. */
  readonly resume: boolean;
  /** A native child's turn permit, and the settlement its boundary commits. */
  readonly turns?: ChildRunBoundary<ToolUseResult>;
  /** Host wiring that is live while the loop can accept an interrupt. */
  readonly attachment?: {
    attach(controls: RunControls): void;
    detach(controls: RunControls): void;
  };
}

interface ToolUseResult {
  readonly outcome: RunOutcome;
  readonly response: string;
  /** Workspace-relative paths of files edited by tool calls. */
  readonly files: readonly string[];
  readonly usage: RunUsageTotals;
  readonly structured: JsonValue | undefined;
  /** The attached memories the run's opening could not read. */
  readonly memoryMisses: readonly AttachedMemoryMiss[];
  readonly error?: RetryErrorInfo;
}

/** A user message the loop appends itself. */
const nudge = (text: string) => ({
  role: 'user' as const,
  content: [{ kind: 'text' as const, text }],
});

export const runToolUse = Effect.fn('toolUse.run')(function* (
  start: ToolUseStart,
): Effect.fn.Return<
  ToolUseResult,
  Error,
  | AgentRun
  | RunHistory
  | ProcessServices
  | Runs
  | ModelInvoker
  | WorkspaceFs
  | StorageFs
  | Scope.Scope
> {
  const run = yield* AgentRun;
  const runHistory = yield* RunHistory;
  const runs = yield* Runs;
  const invoker = yield* ModelInvoker;
  const languageModel = yield* LanguageModel;
  const { runId, session, logger } = run;
  const isChild = () => (runs.getHandle(runId)?.parent ?? null) !== null;
  // A script's run: it opens on the call it was handed and ends when that
  // call settles.
  const script = run.config.script ?? null;
  // A conversation claims its own input lease, never a parent's (FollowUps).
  const followUps = yield* claimFollowUps(run, runHistory);
  const compaction = yield* backgroundCompaction({
    runId,
    logger,
    invoker,
    stores: session.roots,
  });

  // ---------------------------------------------------------------- state
  // What the run read since this loop started: an edit of an existing file
  // requires one. Memory only: a resumed run reads again.
  const readFiles = new Set<string>();
  // The system text a fresh run renders, until its opening batch records it.
  let openingSystem: string | undefined;
  // The text the turn answers with, reported with its end.
  let response = '';

  // A resumed root's first continuation-pinning step stands it down first.
  let resumeUnseen = start.resume;
  // What a step's system text and skill roots are built from: the run's
  // recorded input, or before its opening commits, the opening's own.
  const system: RunSystem = {
    base: (state) =>
      state.input.system === undefined
        ? openingSystem
        : stored(state, state.input.system, z.string()),
    activated: (state) =>
      state.phase === null
        ? (run.opening?.activated ?? [])
        : (state.input.activated ?? []),
    isChild,
  };
  const openStep = (state: RunState, kind: 'request' | 'dispatch' | 'park') =>
    Effect.tap(stepFor(run, state, kind, system), (step) => {
      if (!resumeUnseen || step.continuation === null || isChild())
        return Effect.void;
      resumeUnseen = false;
      return step.continuation
        .onResume({ session, runId })
        .pipe(Effect.provide(step.tools.services));
    });

  // ------------------------------------------------------------ host port
  let live = false;
  const controls: RunControls = {
    oneShot: run.toolPolicy.stopAfterCycle === true,
    // Queued on the run's input, durable at once: the next model boundary
    // compacts and consumes it, and a parked loop wakes for that turn.
    requestImmediateCompaction(): void {
      session.followUps.sendDetached(runId, {
        text: '/compact',
        from: { kind: 'user' },
        control: { kind: 'compact' },
      });
    },
    // Applied at the loop's next park, before any input it takes there: a
    // park is a settled position, so the edit never cuts a turn.
    editView: (handoff) =>
      Effect.gen(function* () {
        if (isChild() || run.toolPolicy.stopAfterCycle)
          return yield* Effect.fail(
            new Error(
              'Only a conversation that waits for its user can be reset.',
            ),
          );
        const done = yield* Deferred.make<void, Error>();
        if (!(yield* followUps.editView({ handoff, done })))
          return yield* Effect.fail(
            new Error('This task is already being reset.'),
          );
        yield* Deferred.await(done);
      }),
    ...modelSwitchPort(run, languageModel),
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
    opening: RunState,
  ): Effect.fn.Return<RunState, Error, ProcessServices> {
    // Keep preparation interruptible inside the masked acquire.
    const { bound, content, offered } = yield* Effect.interruptible(
      Effect.gen(function* () {
        const bound = yield* SynchronizedRef.get(run.model);
        // A script's run renders no prompt: what it runs is its call.
        if (script !== null) {
          const step = yield* openStep(opening, 'request');
          const content: InputPart[] = [
            { kind: 'text', text: `Run the script "${script.title}".` },
          ];
          return { bound, content, offered: step.rows };
        }
        const { inputs } =
          run.opening ?? (yield* Effect.die(new Error(`${runId}: no opening`)));
        const prompts = yield* buildInitialToolUsePrompts(
          run.persona.prompt,
          inputs,
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
                  run.fileService.createLocation(p),
                ),
                bound,
                logger,
                run.session.roots.config,
              )
            : Effect.succeed({ parts: [], kinds: [] }),
        );
        if (run.initialUserMessageForTranscript) {
          logUserMessage(logger, run.initialUserMessageForTranscript, {
            attachments: Exit.isSuccess(media) ? media.value.kinds : [],
          });
        }
        if (Exit.isFailure(media)) return yield* Effect.failCause(media.cause);
        content.push(...media.value.parts);
        content.push({ kind: 'text', text: userRequest });
        const hooked = yield* openingHooks(run, opening, userRequest);
        content.push(...hooked.parts);
        return { bound, content, offered: [...step.rows, ...hooked.rows] };
      }),
    );
    const activated = run.opening?.activated ?? [];
    const misses = run.opening?.attachedMemoryMisses ?? [];
    // The opening: its message with what it answers, the step it opened
    // on, the binding it runs on, and the position that opens the run.
    const opened = yield* runHistory.appendBatch(runId, null, [
      appendRow(runId, [{ role: 'user', content }], {
        input: {
          ...(openingSystem !== undefined && { system: sha256(openingSystem) }),
          ...(activated.length > 0 && { activated: [...activated] }),
          ...(misses.length > 0 && { memoryMisses: misses }),
        },
      }),
      ...offered,
      configRow(runId, run.config, bound.modelId, {
        backend: bound.backend,
        declinedRoutes: run.declinedRoutes,
      }),
      positionRow(runId, opening, 'turn.ready'),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return opened;
  });

  // ------------------------------------------------------------ the turn
  const runTurn = Effect.fn('toolUse.turn')(function* (
    cell: RunCell,
  ): Effect.fn.Return<
    RunExit,
    Error,
    AgentRun | RunHistory | ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    let state = yield* cell.current;
    // A turn begins at a settled boundary; a resumed one where its rows left.
    const begins = state.phase === 'waiting' || state.phase === 'halted';
    /** The turn's completed exit; the stage closes with its own verdict. */
    const completeTurn = (at: RunState): RunExit => ({
      state: at,
      outcome: 'completed',
    });
    const scriptEnd = Effect.fn('toolUse.scriptEnd')(function* (at: RunState) {
      const settled = yield* scriptSettlement(session, runId);
      if (settled?.failed !== true) return completeTurn(at);
      response = settled.reply;
      return { state: at, outcome: 'failed' } satisfies RunExit;
    });
    const body = Effect.gen(function* () {
      if (begins) {
        response = '';
        state = yield* cell.append([
          positionRow(runId, { ...state, turn: state.turn + 1 }, 'turn.begin'),
        ]);
      }
      if (script !== null && state.round === 0)
        state = yield* cell.append(yield* handedDown(run, state, script));
      /**
       * The policy a committed text-only response runs, read off the rows:
       * a blank turn after a tool result asks once more, the terminal tool
       * gets one forced turn per turn, and otherwise the turn ends with
       * this text. Each nudge is an `append` naming its reason, so a resume
       * finds the policy where the rows left it. `done` ends the turn.
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
            logger.emit({ type: 'response.finalized', text });
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
          state,
          cell,
          (at) => compaction.settle(at, 'the model is switching'),
          yield* followUps.controls,
        );
        if (state.pendingResponse !== null) {
          // A user's follow-up to a stopped response joins its delivery.
          const joined = yield* followUps.joinStopped(state);
          const dispatched = yield* dispatchPendingResponse(
            cell,
            readFiles,
            (yield* openStep(state, 'dispatch')).tools,
            joined,
          );
          state = dispatched.state;
          joined?.delivered();
          // A script's run ends with its one call.
          if (script !== null && !joined) return yield* scriptEnd(state);
          if (dispatched.endTurn && !joined) return completeTurn(state);
          continue;
        }
        // A script's run asks no model: delivered, it ends as its call did.
        if (script !== null && state.round > 0) return yield* scriptEnd(state);
        // A committed text-only response whose policy has not run: the
        // response this turn just received, or one a resume finds.
        const last =
          state.at === 'response.ready' && state.invocation === null
            ? state.messages.at(-1)
            : undefined;
        if (last?.role === 'assistant') {
          const text = answerOf(last);
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
        let tools = toolDefinitionsFor(step.tools.definitions);
        // One round: the compaction the history may need, the `/compact`s
        // it answers, then the invocation. An open attempt's history
        // is fixed; it is neither compacted nor re-admitted.
        if (state.invocation === null) {
          // The queued `/compact`s are consumed by the edit that answers
          // them, or, with nothing to summarize, by this round's admission.
          const controls = yield* followUps.controls;
          const requests = consumedRows(runId, controls, 'compact');
          state = yield* cell.adopt(
            yield* compaction.atBoundary(state, cell, bound, requests),
          );
          // A compaction replaced the history, the context updates in it
          // too: a new step renders the system text anew, each one in it.
          if (state.offeredContext === null) {
            step = yield* openStep(state, 'request');
            state = yield* cell.append(step.rows);
            tools = toolDefinitionsFor(step.tools.definitions);
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
          bound.supportsForcedToolChoice
            ? { name: run.finalToolName }
            : undefined;
        const outcome = yield* invoker.invoke(cell, {
          tools,
          toolChoice,
          system: step.system,
          // The model call this request is: the attempt row counts a new
          // one, a retry of the open attempt is the same call.
          round: state.invocation === null ? state.round + 1 : state.round,
          debugName: 'tooluse',
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
    // The follow-ups the rows still queue (input admitted while no consumer
    // held this run, or a batch a crash left unconsumed, C3) are the
    // publisher's, seeded where `loadRun`'s claim moved here.
    const entry = yield* loadRun(runId, start.resume);
    if (entry._tag === 'fresh')
      return yield* makeRunCell(runId, yield* openFresh(entry.opening));
    // A run parked after a turn answers with that turn's text, which a
    // resumed child that runs no further turn hands its call.
    const { loaded } = entry;
    const last = loaded.messages.at(-1);
    if (
      (loaded.phase === 'waiting' || loaded.phase === 'halted') &&
      last?.role === 'assistant'
    )
      response = answerOf(last);
    logger.debug('Resuming tool-use run from the run history.');
    return yield* makeRunCell(runId, loaded);
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
          // A native child waits in this same run scope, just like its root:
          // its loop has already delivered the turn offered at the boundary.
          const queued = yield* followUps.hasQueued;
          if (isChild() && afterError && !queued)
            return finish(state, RUN_OUTCOME.FAILED);
          // Activation clears the visible step: restore an idle cursor's park.
          if (restoring && !queued)
            state = yield* cell.append([positionRow(runId, state, 'waiting')]);
          restoring &&= queued;
          // A child's idle is its parent's; the policy sees failed turns too.
          const canContinue = !run.toolPolicy.stopAfterCycle && !queued;
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
            next !== null && !(yield* followUps.hasQueued)
              ? { kind: 'synthetic', text: next }
              : null;
          if (batch === null) {
            // The host port stays attached: `/model`, `/compact` land here.
            batch = yield* followUps.wait;
            if (batch === null) {
              // The input ended under the parked loop: a cancellation.
              return finish(
                state,
                afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.CANCELLED,
              );
            }
          }
          // A reset or handoff replaces the view a background summary
          // was computed from: that summary lands, or stops, first.
          const consumed: ConsumedFollowUps = yield* followUps.consume(
            state,
            batch,
            batch.kind === 'edit'
              ? (at) => compaction.settle(at, 'the task is being reset')
              : undefined,
          );
          yield* cell.adopt(consumed.state);
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
        state = yield* cell.adopt(yield* compaction.finish(state));
        // The turn's trace rows are queued ahead of the boundary: the
        // barrier lets the open streams `waiting` closes count every one.
        yield* session.log.settled;
        // The turn boundary, in one batch: Stop hooks, the
        // steps (`waiting` closes open streams), a child's settlement, and a
        // Stop hook's block or input already queued, under a fresh step.
        const { rows: hooks, block } = yield* stopHooks(run, turn, response);
        const goesOn =
          script === null &&
          !run.toolPolicy.stopAfterCycle &&
          turn.outcome === 'completed';
        const settlement =
          start.turns && goesOn && block === null
            ? yield* start.turns.settleBoundary(result(turn.outcome, state))
            : null;
        const ending = [
          positionRow(runId, state, 'turn.end'),
          ...session.trace.closure(runId),
          positionRow(runId, state, 'waiting'),
          ...(settlement?.rows ?? []),
        ];
        const next = block ?? (goesOn ? yield* followUps.takeQueued : null);
        const pin =
          next !== null && !isChild() ? yield* openStep(state, 'park') : null;
        state =
          next === null
            ? yield* cell.append([...hooks, ...ending])
            : yield* cell.adopt(
                (yield* followUps.consume(state, next, undefined, {
                  rows: [...hooks, ...ending, ...(pin?.rows ?? [])],
                })).state,
              );
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
        if (run.toolPolicy.stopAfterCycle && turn.outcome === 'completed')
          return finish(state, turn.outcome);
        if (script !== null) return finish(state, turn.outcome);
        if (settlement !== null)
          yield* Effect.uninterruptible(settlement.settled);
      }
    });

  /** A run that ends here: its halt commits with its `run.end`. */
  const finish = (state: RunState, outcome: RunOutcome): RunExit =>
    ({ state, outcome }) as const;

  const result = (outcome: RunOutcome, at: RunState): ToolUseResult => ({
    outcome,
    response,
    files: [...at.edited],
    usage: at.usage,
    structured: at.structured?.value,
    memoryMisses: at.input.memoryMisses ?? [],
    ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
      ? { error: at.lastError }
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
            cell.current.pipe(
              Effect.flatMap((at) => compaction.settle(at, 'the run stopped')),
              Effect.flatMap(cell.adopt),
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
