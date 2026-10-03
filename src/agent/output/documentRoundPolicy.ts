/**
 * The documents plugin's round mode: a workflow agent's run, one round per
 * turn with no tools offered. `makeDocumentRounds` builds each round's prompt
 * and turns its text into output files; this policy opens the next round or
 * ends the run, plus the few places a round differs from a conversational
 * turn. TeXRA's table contributes it for the workflow category
 * (`@tools/registry`); the loop's side is `@agent/runtime/loop/rounds`.
 *
 * - A round's stage is `r<index>` with the index and total from the policy.
 *   The index is the turn less one, never `state.round`, which the loop
 *   bumps on every model call.
 * - A round's text is its committed response, read off the fold, so the live
 *   path and a resume's replay of that response process the same text. It is
 *   not finalized as the assistant's answer: the documents are the output.
 * - A context-window overflow is recovered once per round (keyed on the
 *   turn): a forced compaction, then the round's request again.
 * - A resume before the next round's opening re-enters the round's committed
 *   response and produces its output again, so nothing this plugin holds in
 *   memory (the compile-failure context the next round's prompt carries)
 *   needs a row.
 */
import { Effect, SynchronizedRef } from 'effect';

import {
  makeDocumentRounds,
  type TurnFinish,
} from '@agent/output/documentRounds';
import { getSystemPromptWithRules } from '@agent/prompt/PromptBuilder';
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
import type {
  RoundMode,
  RoundPolicy,
  RoundTurns,
} from '@agent/runtime/loop/rounds';
import type { RunCell } from '@agent/runtime/loop/runProgram';
import { ModelInvoker } from '@agent/runtime/ModelInvoker';
import type { AgentRunShape } from '@agent/runtime/run/AgentRun';
import { compactIfNeeded } from '@agent/runtime/run/compaction';
import { turnText } from '@agent/runtime/run/turnText';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import {
  AgentCategory,
  MESSAGE_TYPES,
  OUTPUT_END_TAG,
  RUN_OUTCOME,
  SCRATCHPAD_TAG,
  type CompileFailure,
} from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runStateFold';
import { extractScratchpad } from '@utils/text/xmlExtraction';

/** Length for the debug preview slices of a round's text. */
const K_SLICE = 200;

/**
 * The compile rejection a resumed run's rows show, read conservatively: no
 * row tells a round that compiled clean from one whose check never ran (auto
 * compile off, or the check errored), so a round's compile failures stand
 * unless the loop's own completed halt found them resolved. The failures are
 * the latest round's when it is the rejected one: the next round's prompt
 * says why.
 */
function rejectionOf(
  state: RunState,
): { readonly failures: readonly CompileFailure[] } | null {
  if (state.phase === 'halted' && state.outcome === RUN_OUTCOME.COMPLETED)
    return null;
  const failed = state.roundOutputs.findLast(
    (round) => round.compileFailures.length > 0,
  );
  if (failed === undefined) return null;
  const latest = failed === state.roundOutputs.at(-1);
  return { failures: latest ? failed.compileFailures : [] };
}

/** The documents plugin's rounds for one workflow run. */
const documentRoundPolicy = Effect.fn('rounds.policy')(function* (
  run: AgentRunShape,
) {
  const { runId, setting, logger, session, prompt } = run;
  const invoker = yield* ModelInvoker;
  if (setting.agentCategory !== AgentCategory.Workflow) {
    return yield* Effect.die(new Error('Round mode requires a workflow run.'));
  }
  // Every round renders its prompts from the launch's template inputs.
  if (run.opening === null) {
    return yield* Effect.die(
      new Error('A workflow run launches with its template inputs.'),
    );
  }
  const { inputs } = run.opening;
  const docs = yield* makeDocumentRounds(setting, inputs);
  const { totalRounds } = docs;

  /** A context-window overflow is recovered once per round: force the
   *  compaction, then append the round's request again after it. Null when
   *  the round stops instead: a second overflow in the round, or a
   *  compaction that shortened nothing. */
  const overflowRetry = Effect.fn('rounds.overflowRetry')(function* (
    initial: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState | null, Error, RunHistory> {
    if (initial.overflowRecoveredAtTurn === initial.turn) {
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
        runHistory: yield* RunHistory,
        logger,
        bound: yield* SynchronizedRef.get(run.model),
        invoker,
        stores: session.roots,
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
        docs.restore(state, rejectionOf(state));
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
          inputs,
          session.roots.workspace,
        ),
        (system) => ({ system, round: index, debugName: `r${index}` }),
      ),
    afterResponse: Effect.fn('rounds.afterResponse')(function* (
      initial: RunState,
      cell: RunCell,
      index: number,
      live: boolean,
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
      // A replay restates the step it resumes at, so a resumed run shows its
      // round rather than no position until the next round opens.
      const at = live
        ? initial
        : yield* cell.append([positionRow(runId, initial, 'response.ready')]);
      if (text) {
        logger.debug(`First ${K_SLICE} chars:\n${text.slice(0, K_SLICE)}`);
        logger.debug(`Last ${K_SLICE} chars:\n${text.slice(-K_SLICE)}`);
      }
      // A response that closed the documents has finished whatever its
      // finish reason says; only an open one is retried or reported cut off.
      const closed = text.includes(OUTPUT_END_TAG);
      if (finish === 'context-window-exceeded' && !closed) {
        const retried = yield* overflowRetry(at, cell);
        if (retried !== null) return { state: retried, done: false };
      }
      // The round's notices go out with its output, ahead of the row that
      // commits it: once per round, however often a crash replays it.
      const produced = at.roundOutputs.some((r) => r.round === index);
      const announce = Effect.gen(function* () {
        const scratchpad = extractScratchpad(text, SCRATCHPAD_TAG);
        if (scratchpad) {
          logger.info(scratchpad, { messageType: MESSAGE_TYPES.SCRATCHPAD });
        }
        if (finish !== 'length' || closed) return;
        const message = `Round ${index + 1} hit the model's output limit, so its output may be incomplete. Raise the model's max output tokens to let it finish.`;
        logger.warn(message);
        // Actionable, so it is also an instruction: the host surface that
        // shows the run's errors and instructions shows it too.
        yield* session.interactions.emit('requestShowInstruction', {
          key: 'roundOutputLimit',
          message,
        });
      });
      const state = yield* docs.afterTurn(
        index,
        { text, finish },
        cell,
        produced ? Effect.void : announce,
      );
      return { state, done: true };
    }),
  };

  return {
    rounds,
    /** At a completed round, a fresh run or a halted one: the next round
     *  while the configured total allows one, else the run's end. The total
     *  is read from configuration, so lowering it takes effect on resume. */
    atIdle: Effect.fn('rounds.atIdle')(function* (state: RunState) {
      if (state.turn < totalRounds) return null;
      const rejected = yield* docs.rejected(state.turn - 1);
      return deriveRunOutcome({
        failed: state.lastError !== null || rejected,
        cancelled: false,
      });
    }),
  } satisfies RoundPolicy;
});

/** The workflow category's round mode. */
export const documentRoundMode: RoundMode = {
  category: AgentCategory.Workflow,
  open: documentRoundPolicy,
};
