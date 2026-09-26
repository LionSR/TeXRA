/**
 * The reflection program: the tool-use loop's shape with one outer
 * coordinate, the round. One plain Effect loop over the run ledger, no cursor
 * and no graph; every phase is row data and the loop continues from the state
 * each `appendBatch` returns, so the live path and the resume path are one
 * function.
 *
 * The write points, in order (manifest section 1.2): the opening snapshot of
 * a fresh run; per round the round prompt with its `model.ready` snapshot and
 * `round.begin`; the invoker's `attempt` / `identified` / `response` rows,
 * then `response.processed` with the `output.pending` snapshot, committed
 * before any file write, and `output.ready`; `round.end` with the snapshot of
 * the next round or of the finished run; and the `halted` step at every exit
 * that ends the run.
 *
 * A round is one response. One cut off by the output limit is not continued:
 * its text is the round's output, processed as far as it got, with a warning
 * on the transcript.
 *
 * A turn the provider refused for exceeding its context window is recovered
 * once per round: the history is compacted (`model.compaction`) and the
 * round's request is issued again against it. A second overflow in the same
 * round stops, and so does a compaction that shortened nothing, because the
 * same history would overflow again.
 *
 * Reflection dispatches no tools: a turn advertises none, so a response never
 * carries a local call and the assistant message enters history with its
 * `response` row. That narrows the retired flow, which forwarded a workflow's
 * declared `setting.tools` to any model that supported function calling: this
 * program has no dispatch site, so advertising a tool would invite a call
 * nothing can settle. A workflow that needs tools runs in the tool-use
 * family, and the reflection run's tool registry is empty by construction.
 */
import { Effect, FileSystem, SynchronizedRef } from 'effect';

import {
  makeDocumentRounds,
  type RoundServices,
  type TurnFinish,
} from '@agent/output/documentRounds';
import { getSystemPromptWithRules } from '@agent/prompt/PromptBuilder';
import type { WorkspaceFs } from '@platform/rootedFs';
import type { LanguageModel } from '@platform/languageModel';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import {
  AgentCategory,
  MESSAGE_TYPES,
  OUTPUT_END_TAG,
  RUN_OUTCOME,
  SCRATCHPAD_TAG,
  type RetryErrorInfo,
  type RoundOutput,
  type RunOutcome,
  type RunUsageTotals,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { type RunState } from '@shared/session/runStateFold';
import { extractScratchpad } from '@utils/text/xmlExtraction';
import { AgentRun } from '../run/AgentRun';
import { compactIfNeeded } from '../run/compaction';
import { turnText } from '../run/turnText';
import { ModelInvoker } from '../ModelInvoker';
import { Runs } from '../runRegistry';
import {
  appendRow,
  familyState,
  snapshotRow,
  stepRow,
  type SnapshotPatch,
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
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import type { HttpClient } from 'effect/unstable/http';

/** Length for the debug preview slices of a response. */
const K_SLICE = 200;

interface ReflectionStart {
  /** The caller launched this as a resume; the ledger decides what it is. */
  readonly resume: boolean;
}

interface ReflectionResult {
  readonly outcome: RunOutcome;
  readonly roundOutputs: RoundOutput[];
  readonly usage: RunUsageTotals;
  /**
   * Structured provider/runtime error behind a FAILED outcome, when present.
   * A rejected compile is an outcome-only domain failure whose diagnostics are
   * carried by roundOutputs instead.
   */
  readonly error?: RetryErrorInfo;
}

type RoundExit = {
  readonly state: RunState;
  readonly kind: RunOutcome;
};

/** The finish reason of a completed turn; the editor arm reports none. */
function finishReasonOf(turn: NonNullable<RunState['lastTurn']>): TurnFinish {
  return turn.kind === 'http' ? turn.finishReason : 'stop';
}

export const runReflection = Effect.fn('reflection.run')(function* (
  start: ReflectionStart,
): Effect.fn.Return<
  ReflectionResult,
  Error,
  | AgentRun
  | RunLedger
  | ModelInvoker
  | FileSystem.FileSystem
  | WorkspaceFs
  | LanguageModel
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Runs
> {
  const run = yield* AgentRun;
  const ledger = yield* RunLedger;
  const invoker = yield* ModelInvoker;
  const { runId, session, logger, prompt } = run;
  const setting = run.setting;
  if (setting.agentCategory !== AgentCategory.Workflow) {
    return yield* Effect.die(
      new Error('runReflection requires a workflow setting.'),
    );
  }

  // ------------------------------------------------------------ services
  // The documents plugin owns the round prompts, the output pipeline and the
  // compile-rejection facts; this program owns the rounds and every row but
  // `output.produced`.
  const docs = yield* makeDocumentRounds(setting);
  const { totalRounds } = docs;

  const snapshot = (state: RunState, patch: Omit<SnapshotPatch, 'state'>) =>
    snapshotRow(runId, state, {
      ...patch,
      state: { family: 'reflection', state: docs.flowState() },
    });
  const resolveOutcome = Effect.fn(function* (state: RunState) {
    const rejected = yield* docs.rejected(state.round);
    return deriveRunOutcome({
      failed: state.lastError !== null || rejected,
      cancelled: false,
    });
  });
  /** The round loop's single continue/finalize decision. */
  const shouldContinueNextRound = (state: RunState): boolean =>
    state.lastError === null && state.round + 1 < totalRounds;

  /** A committed response's text as the round writes it. */
  const responseOf = (turn: NonNullable<RunState['lastTurn']>) =>
    Effect.map(
      session.responseTextProcessing.postProcessResponse(
        turnText(turn),
        session.roots.config,
      ),
      (text) => ({ finish: finishReasonOf(turn), text }),
    );

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('reflection.open')(function* (
    opening: RunState,
  ): Effect.fn.Return<RunState, Error> {
    yield* docs.opening;
    const bound = yield* SynchronizedRef.get(run.model);
    const opened = yield* ledger.appendBatch(runId, null, [
      snapshotRow(runId, opening, {
        phase: 'round.ready',
        round: 0,
        runtime: {
          modelId: bound.modelId,
          modelCompatibilityKey: bound.compatibilityKey,
        },
        state: { family: 'reflection', state: docs.flowState() },
      }),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return opened;
  });

  /** Restore the family state a resumed run continues from. */
  const restore = Effect.fn('reflection.restore')(function* (
    state: RunState,
  ): Effect.fn.Return<void, Error> {
    if (familyState(state, 'reflection') === null) {
      return yield* Effect.die(
        new Error(`Run ${runId} is not a reflection run; resume it as one.`),
      );
    }
    // A resumed run retries the invocation its failure interrupted rather
    // than failing again at once.
    docs.restore(state);
    logger.debug(
      `Resuming reflection run from round ${state.round}/${totalRounds}`,
    );
  });

  // ----------------------------------------------------------- the round
  /** The round prompt, committed with `round.begin`. */
  const prepareRound = Effect.fn('reflection.prepareRound')(function* (
    initial: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState, Error, RoundServices> {
    const round = initial.round;
    const content = yield* docs.nextRound(round);
    return yield* cell.append([
      appendRow(runId, [{ role: 'user', content }]),
      snapshot(initial, { phase: 'model.ready', round, continuationIndex: 0 }),
      stepRow(runId, initial, 'round.begin'),
    ]);
  });

  /**
   * A context-window overflow is recoverable once per round: force the
   * compaction the history needs, then re-issue the round's request against
   * it. The compaction replaces the whole history with one summary, so the
   * round's request (the last user message, since reflection dispatches no
   * tools) is appended again after it. Returns the state the retried request
   * is issued from, or `null` when the round stops instead: a second overflow
   * in the round (the fold records the round of its `context-window`
   * compaction), or a compaction that shortened nothing, because the same
   * history would overflow again.
   */
  const admitOverflowRetry = Effect.fn('reflection.overflowRetry')(function* (
    initial: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState | null, Error> {
    if (initial.overflowRecoveredAtRound === initial.round) {
      logger.warn(
        'Model context window still exceeded after forced compaction; stopping to avoid a futile retry.',
      );
      return null;
    }
    const request = initial.messages.findLast(
      (message) => message.role === 'user',
    );
    if (request === undefined) {
      return yield* Effect.die(
        new Error('An overflowed round has no request to issue again.'),
      );
    }
    const bound = yield* SynchronizedRef.get(run.model);
    // The retry pays for a summary first: the compaction row is committed
    // before the request is appended again, so the retried request is issued
    // against the compacted history the fold returns.
    const compacted = yield* cell.adopt(
      yield* compactIfNeeded(initial, {
        runId,
        ledger,
        logger,
        bound,
        stores: session.roots,
        system: undefined,
        tools: [],
        force: 'overflow',
      }),
    );
    if (compacted === initial) {
      logger.warn(
        'Model context window exceeded and compaction shortened nothing; stopping to avoid a futile retry.',
      );
      return null;
    }
    logger.info('Retrying the round after forcing model context compaction', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });
    return yield* cell.append([
      appendRow(runId, [request]),
      snapshot(compacted, {
        phase: 'model.ready',
        // A response arrived: the run is no longer failed, and this
        // snapshot is what records that.
        runtime: { lastError: null },
      }),
      stepRow(runId, compacted, 'response.processed'),
    ]);
  });

  /**
   * Process the committed response the state holds and commit the next
   * phase, the overflow retry or `output.pending`, together with
   * `response.processed`. A response cut off by the output limit is not
   * continued: the round's output is what it wrote, with a warning.
   */
  const processResponse = Effect.fn('reflection.processResponse')(function* (
    initial: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState, Error> {
    const turn = initial.lastTurn;
    if (turn === null) {
      return yield* Effect.die(
        new Error('A response is processed only after its row and its round.'),
      );
    }
    const { finish, text } = yield* responseOf(turn);
    logger.debug(`Stop reason: ${finish}`);
    const scratchpad = extractScratchpad(text, SCRATCHPAD_TAG);
    if (scratchpad) {
      logger.info(scratchpad, { messageType: MESSAGE_TYPES.SCRATCHPAD });
    }
    if (text) {
      logger.debug(`First ${K_SLICE} chars:\n${text.slice(0, K_SLICE)}`);
      logger.debug(`Last ${K_SLICE} chars:\n${text.slice(-K_SLICE)}`);
    }
    // A response that closed the documents has finished whatever its finish
    // reason says; only an open one is retried or reported as cut off.
    const closed = text.includes(OUTPUT_END_TAG);
    if (finish === 'context-window-exceeded' && !closed) {
      const retried = yield* admitOverflowRetry(initial, cell);
      if (retried !== null) return retried;
    }
    if (finish === 'length' && !closed) {
      logger.warn(
        `Round ${initial.round + 1} hit the model's output limit, so its output may be incomplete. Raise the model's max output tokens to let it finish.`,
      );
    }
    // `output.pending` is committed before any output file is touched, so
    // a re-entry at this phase knows the pipeline may have started.
    return yield* cell.append([
      snapshot(initial, {
        phase: 'output.pending',
        runtime: { lastError: null },
      }),
      stepRow(runId, initial, 'response.processed'),
      stepRow(runId, initial, 'output.ready'),
    ]);
  });

  /**
   * The round's output, entered at `output.pending`, which was committed
   * before any file write; re-entry at that phase runs the pipeline again
   * over the same raw output. `output.pending` stays replayable until round
   * end.
   */
  const produceOutput = Effect.fn('reflection.produceOutput')(function* (
    state: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState, Error, RoundServices> {
    if (state.lastTurn === null) {
      return yield* Effect.die(new Error('Output needs the round response.'));
    }
    // The round's raw output is its last response's text, from the folded
    // turn; re-entry rewrites it whole from the same row.
    return yield* docs.afterTurn(
      state.round,
      yield* responseOf(state.lastTurn),
      cell,
    );
  });
  /** One round inside its trace stage: prompt, response, output. */
  const runRound = Effect.fn('reflection.round')(function* (
    cell: RunCell,
  ): Effect.fn.Return<
    RoundExit,
    Error,
    RoundServices | LanguageModel | HttpClient.HttpClient
  > {
    const round = (yield* cell.current).round;
    const body = Effect.gen(function* () {
      let state = yield* cell.current;
      if (state.phase === 'round.ready')
        state = yield* prepareRound(state, cell);
      while (
        state.phase === 'model.ready' ||
        state.phase === 'model.submitted'
      ) {
        const unprocessed =
          state.openAttempt === null &&
          state.lastTurn !== null &&
          state.phase !== 'model.ready';
        if (!unprocessed) {
          const system = yield* getSystemPromptWithRules(
            prompt.systemPrompt,
            run.userVarChannels,
            session.roots.workspace,
          );
          const outcome = yield* invoker.invoke(cell, {
            system,
            tools: [],
            toolChoice: undefined,
            round,
            debugName: `r${round}`,
          });
          state = outcome.state;
          if (outcome.kind === 'cancelled') {
            return { state, kind: 'cancelled' } as const;
          }
          if (outcome.kind === 'failed') {
            return { state, kind: 'failed' } as const;
          }
          yield* recordServedUsage(run, state, outcome.usage);
        }
        state = yield* processResponse(state, cell);
      }
      if (state.phase === 'output.pending') {
        state = yield* produceOutput(state, cell);
      }
      return { state, kind: 'completed' } as const;
    });
    return yield* stagedBy(
      () =>
        logger.openStage(`r${round}`, {
          parent: run.parentStage,
          kind: 'round',
          index: round,
          total: totalRounds,
        }),
      (exit: RoundExit) => exit.kind,
    )(body);
  });

  // ------------------------------------------------------------- the loop
  type LoopExit = { readonly state: RunState; readonly outcome: RunOutcome };
  const enter = Effect.gen(function* () {
    const entry = yield* loadRun(runId, 'reflection', start.resume);
    const opened =
      entry._tag === 'fresh'
        ? yield* openFresh(entry.opening)
        : yield* Effect.as(restore(entry.loaded), entry.loaded);
    return yield* makeRunCell(runId, opened);
  });

  const loopBody = (cell: RunCell) =>
    Effect.gen(function* () {
      yield* docs.enter;

      /**
       * Advance onto the next round: reset the round's media workspace, then
       * commit the `round.ready` snapshot.
       *
       * `closePrevious` says whether a round is actually being closed. Ending
       * one emits `round.end` against the folded state captured *before* the
       * advance; relaunching a halted run enters a round without a
       * predecessor to close, and that is the only difference between the two
       * entries. The snapshot clears the error fact: relaunching is the
       * admission of a new attempt, so nothing restates a failure the run has
       * moved past.
       */
      const enterRound = Effect.fn('reflection.enterRound')(function* (
        current: RunState,
        closePrevious: boolean,
      ): Effect.fn.Return<RunState, Error> {
        docs.resetWorkspace();
        return yield* cell.append([
          ...(closePrevious ? [stepRow(runId, current, 'round.end')] : []),
          snapshot(current, {
            phase: 'round.ready',
            round: current.round + 1,
            continuationIndex: 0,
            runtime: { lastError: null },
          }),
        ]);
      });
      const finish = Effect.fn('reflection.finish')(function* (
        current: RunState,
        roundEnded: boolean,
      ): Effect.fn.Return<LoopExit, Error, ChildProcessSpawner> {
        const outcome = yield* resolveOutcome(current);
        const state = yield* cell.append([
          ...(roundEnded ? [stepRow(runId, current, 'round.end')] : []),
          snapshot(current, { phase: 'halted' }),
        ]);
        return { state, outcome };
      });

      for (;;) {
        let state = yield* cell.current;
        if (state.phase === 'halted') {
          // A finished run launched again continues only if rounds remain
          // under the current configuration. The restored error fact does not
          // decide this: relaunching is the admission of a new attempt.
          if (state.round + 1 >= totalRounds) {
            return {
              state,
              outcome: yield* resolveOutcome(state),
            } satisfies LoopExit;
          }
          state = yield* enterRound(state, false);
        }
        // The configured total may have been lowered since the snapshot; the
        // hard round limit takes precedence over continuing that round.
        if (state.round >= totalRounds) {
          return yield* finish(state, false);
        }
        const exit = yield* runRound(cell);
        state = exit.state;
        if (exit.kind === 'cancelled') {
          return { state, outcome: RUN_OUTCOME.CANCELLED } satisfies LoopExit;
        }
        if (exit.kind === 'failed') {
          return { state, outcome: RUN_OUTCOME.FAILED } satisfies LoopExit;
        }
        if (!shouldContinueNextRound(state)) return yield* finish(state, true);
        state = yield* enterRound(state, true);
      }
    });

  const result = (outcome: RunOutcome, at: RunState): ReflectionResult => ({
    outcome,
    roundOutputs: docs.outputs(),
    usage: at.usage,
    ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
      ? { error: at.lastError }
      : {}),
  });

  // Every ledger append the loop makes is uninterruptible inside
  // `cell.append`, so the halt the release writes never folds onto a state
  // behind the rows. Reflection holds no input lease.
  return yield* Effect.acquireUseRelease(enter, loopBody, (cell, exit) =>
    settleRun(cell, logger, null)(exit),
  ).pipe(
    Effect.map((loop) => result(loop.outcome, loop.state)),
    Effect.catchCause(stoppedBy(logger, `Reflection run ${runId}`)),
  );
});
