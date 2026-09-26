/**
 * Round mode: a workflow agent run by the tool-use loop. A round is one turn
 * with no tools offered; the documents plugin (`@agent/output/documentRounds`)
 * builds its prompt and turns its text into output files, and this module is
 * the continuation policy that opens the next round or ends the run, plus the
 * few places a round differs from a conversational turn.
 *
 * - A round's stage is `r<index>` with the index and total from the policy.
 *   The index is the turn less one, never `state.round`, which the loop
 *   bumps on every model call.
 * - A round's text is its committed response, read off the fold, so the live
 *   path and a resume's replay of that response process the same text. It is
 *   not finalized as the assistant's answer: the documents are the output.
 * - Threshold compaction is off, since a later round works on the earlier
 *   documents. A context-window overflow is recovered once per round (keyed
 *   on the turn): a forced compaction, then the round's request again.
 * - Rounds take no input: no follow-up lease, and a failed round ends the run
 *   where it stopped, so resuming it issues that round's request again.
 * - No idle between rounds: a round's turn stays open until the next round's
 *   opening closes it (`turn.end` in that batch) or the run halts. A resume
 *   before that re-enters the round's committed response and produces its
 *   output again, so nothing the documents plugin holds in memory (the
 *   compile-failure context the next round's prompt carries) needs a row.
 */
import { Effect, SynchronizedRef } from 'effect';

import {
  makeDocumentRounds,
  type RoundServices,
  type TurnFinish,
} from '@agent/output/documentRounds';
import { getSystemPromptWithRules } from '@agent/prompt/PromptBuilder';
import type { StageHandle } from '@agent/trace';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import {
  AgentCategory,
  MESSAGE_TYPES,
  OUTPUT_END_TAG,
  SCRATCHPAD_TAG,
  type RunOutcome,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import { extractScratchpad } from '@utils/text/xmlExtraction';

import { compactIfNeeded } from '../run/compaction';
import { turnText } from '../run/turnText';
import { appendRow, stepRow, type SnapshotPatch } from './rows';
import type { AgentRunShape } from '../run/AgentRun';
import type { InputPart } from '../run/mediaInput';
import type { ContinuationPolicy } from './continuationPolicy';
import type { RunCell } from './runProgram';

/** Length for the debug preview slices of a round's text. */
const K_SLICE = 200;

/** What the tool-use loop asks of a round. */
export interface RoundTurns {
  readonly totalRounds: number;
  /** Every entry, before a round: the outputs and rejection facts the rows
   *  hold, then run-workspace preparation. */
  readonly enter: (
    state: RunState,
  ) => Effect.Effect<void, Error, RoundServices>;
  readonly stage: (index: number) => StageHandle;
  /** The user content that opens round `index`. */
  readonly open: (
    index: number,
  ) => Effect.Effect<InputPart[], Error, RoundServices>;
  /** The system text and debug coordinates of round `index`'s request. */
  readonly request: (index: number) => Effect.Effect<
    {
      readonly system: string;
      readonly round: number;
      readonly debugName: string;
    },
    Error,
    RoundServices
  >;
  /** A committed response of round `index`: the overflow retry's request
   *  (not done), or the round's output (done). */
  readonly afterResponse: (
    state: RunState,
    cell: RunCell,
    index: number,
  ) => Effect.Effect<
    { readonly state: RunState; readonly done: boolean },
    Error,
    RoundServices | RunLedger
  >;
}

/** The documents plugin's continuation policy for one workflow run. */
export const roundsContinuation = Effect.fn('rounds.policy')(function* (
  run: AgentRunShape,
) {
  const { runId, setting, logger, session, prompt } = run;
  if (setting.agentCategory !== AgentCategory.Workflow) {
    return yield* Effect.die(new Error('Round mode requires a workflow run.'));
  }
  const docs = yield* makeDocumentRounds(setting);
  const { totalRounds } = docs;

  /** A context-window overflow is recovered once per round: force the
   *  compaction, then append the round's request again after it. Null when
   *  the round stops instead: a second overflow in the round, or a
   *  compaction that shortened nothing. */
  const overflowRetry = Effect.fn('rounds.overflowRetry')(function* (
    initial: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState | null, Error, RunLedger> {
    if (initial.overflowRecoveredAt?.turn === initial.turn) {
      logger.warn(
        'Model context window still exceeded after forced compaction; stopping to avoid a futile retry.',
      );
      return null;
    }
    const request = initial.messages.findLast((m) => m.role === 'user');
    if (request === undefined) {
      return yield* Effect.die(
        new Error('An overflowed round has no request to issue again.'),
      );
    }
    const compacted = yield* cell.adopt(
      yield* compactIfNeeded(initial, {
        runId,
        ledger: yield* RunLedger,
        logger,
        bound: yield* SynchronizedRef.get(run.model),
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
    return yield* cell.append([appendRow(runId, [request])]);
  });

  const rounds: RoundTurns = {
    totalRounds,
    enter: (state) =>
      Effect.suspend(() => {
        docs.restore(state);
        return docs.enter;
      }),
    stage: (index) =>
      logger.openStage(`r${index}`, {
        parent: run.parentStage,
        kind: 'round',
        index,
        total: totalRounds,
      }),
    open: docs.nextRound,
    request: (index) =>
      Effect.map(
        getSystemPromptWithRules(
          prompt.systemPrompt,
          run.userVarChannels,
          session.roots.workspace,
        ),
        (system) => ({ system, round: index, debugName: `r${index}` }),
      ),
    afterResponse: Effect.fn('rounds.afterResponse')(function* (
      initial: RunState,
      cell: RunCell,
      index: number,
    ) {
      const turn = initial.lastTurn;
      if (turn === null) {
        return yield* Effect.die(
          new Error('A round is processed only after its response row.'),
        );
      }
      const finish: TurnFinish =
        turn.kind === 'http' ? turn.finishReason : 'stop';
      const text = yield* session.responseTextProcessing.postProcessResponse(
        turnText(turn),
        session.roots.config,
      );
      logger.debug(`Stop reason: ${finish}`);
      const scratchpad = extractScratchpad(text, SCRATCHPAD_TAG);
      if (scratchpad) {
        logger.info(scratchpad, { messageType: MESSAGE_TYPES.SCRATCHPAD });
      }
      if (text) {
        logger.debug(`First ${K_SLICE} chars:\n${text.slice(0, K_SLICE)}`);
        logger.debug(`Last ${K_SLICE} chars:\n${text.slice(-K_SLICE)}`);
      }
      // A response that closed the documents has finished whatever its
      // finish reason says; only an open one is retried or reported cut off.
      const closed = text.includes(OUTPUT_END_TAG);
      if (finish === 'context-window-exceeded' && !closed) {
        const retried = yield* overflowRetry(initial, cell);
        if (retried !== null) return { state: retried, done: false };
      }
      if (finish === 'length' && !closed) {
        logger.warn(
          `Round ${index + 1} hit the model's output limit, so its output may be incomplete. Raise the model's max output tokens to let it finish.`,
        );
      }
      const state = yield* docs.afterTurn(index, { text, finish }, cell);
      return { state, done: true };
    }),
  };

  return {
    rounds,
    /** At a completed round, a fresh run or a halted one: the next round
     *  while the configured total allows one, else the run's end. The total
     *  is read from configuration, so lowering it takes effect on resume. */
    atIdle: Effect.fn('rounds.atIdle')(function* (state: RunState) {
      if (state.turn < totalRounds) return { round: state.turn };
      const rejected = yield* docs.rejected(state.turn - 1);
      return {
        finish: deriveRunOutcome({
          failed: state.lastError !== null || rejected,
          cancelled: false,
        }),
      };
    }),
  } satisfies ContinuationPolicy;
});

type TurnExit = { readonly state: RunState; readonly outcome: RunOutcome };

/**
 * The round loop, over the tool-use loop's turn. `runTurn(cell, next)` opens
 * a round when `next` is set (closing the completed one) or the run is at a
 * fresh or halted boundary, and otherwise continues the round the rows left
 * open. `snapshot` is the loop's own snapshot row, family state included.
 */
export const roundLoop =
  <R>(
    policy: ContinuationPolicy,
    rounds: RoundTurns,
    runTurn: (
      cell: RunCell,
      next: boolean,
    ) => Effect.Effect<TurnExit, Error, R>,
    snapshot: (
      state: RunState,
      patch: Omit<SnapshotPatch, 'state'>,
    ) => RunLedgerDraft,
  ) =>
  (cell: RunCell) =>
    Effect.gen(function* () {
      const { runId } = cell;
      yield* rounds.enter(yield* cell.current);
      /** The last round produced its output; its turn is still open. */
      let completed = false;
      for (;;) {
        const state = yield* cell.current;
        const idle =
          completed || state.phase === 'initial' || state.phase === 'halted';
        // A round the rows left open past a lowered total is not continued.
        if (idle || state.turn > rounds.totalRounds) {
          const next = yield* policy.atIdle(state, true);
          if (next !== null && 'finish' in next) {
            if (state.phase === 'halted')
              return { state, outcome: next.finish };
            const halted = yield* cell.append([
              ...(completed ? [stepRow(runId, state, 'turn.end')] : []),
              snapshot(state, { phase: 'halted' }),
            ]);
            return { state: halted, outcome: next.finish };
          }
        }
        const turn = yield* runTurn(cell, completed);
        // A failed or stopped round ends the run where it stopped.
        if (turn.outcome !== 'completed') return turn;
        completed = true;
      }
    });
