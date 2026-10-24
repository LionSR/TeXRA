/**
 * The loops' row constructors: every run history draft a loop appends, built
 * from the folded `RunState` and nothing else. A `run.position` is the one
 * record of where the loop stands; a `run.config` is what the run runs on
 * (its model and binding); an `append` carries what its messages change
 * about the run's input. Every fact a row already carries (the pending
 * response, its intents, the invocation's attempts
 * and failures) is folded from that row and never restated here.
 */

import { randomUUID } from 'node:crypto';

import { Effect, SynchronizedRef } from 'effect';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import {
  qualifyAggregateId,
  type PositionAt,
  type RunBinding,
  type RunId,
  type RunInput,
  type RunOutcome,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { HistoryMessageDraft } from '@shared/session/historyTurns';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import { generateShortId } from '@utils/core';
import { dispatchFactsFor } from '../run/tools';

import type { AgentRunShape } from '../run/AgentRun';

/** A message the loop appends: the history's, a media part with its bytes
 *  in hand included (the row codec stores them under their address). */
export type Message = HistoryMessageDraft;

export function rowAggregate(runId: RunId) {
  return qualifyAggregateId('run', runId);
}

/** The row making `text` the response shown as final: a row of the run's
 *  history, awaited, never a detached trace row. */
export const finalizedRows = (
  runId: RunId,
  text: string,
): RunHistoryDraft[] => [
  { type: 'response.finalized', aggregateId: rowAggregate(runId), text },
];

/** The coordinates a `run.position` row is stamped with. */
export type PositionCoordinates = Pick<RunState, 'turn'>;

/** Where the loop stands; a run's first one opens it. */
export function positionRow(
  runId: RunId,
  state: PositionCoordinates,
  at: Exclude<PositionAt, 'halted'>,
): RunHistoryDraft {
  return {
    type: 'run.position',
    aggregateId: rowAggregate(runId),
    payload: { family: 'toolUse', at, turn: state.turn },
  };
}

/** The loop's halt where its newest position left it, with the run's
 *  outcome: written only with the run's `run.end`, so a stopped run never
 *  reads as interrupted. */
export function haltedPositionRow(
  position: Extract<SessionEvent, { type: 'run.position' }>,
  outcome: RunOutcome,
): Extract<RunHistoryDraft, { type: 'run.position' }> {
  const { family, turn } = position.payload;
  return {
    type: 'run.position',
    aggregateId: position.aggregateId,
    payload: { family, at: 'halted', turn, outcome },
  };
}

/** Messages appended to the run's history: `input` is what they change
 *  about what the run answers, `reason` names a message the loop wrote
 *  itself (`model.message` `append`). */
export function appendRow(
  runId: RunId,
  messages: readonly Message[],
  options: {
    readonly sourceResponse?: string | null;
    readonly input?: RunInput;
    readonly reason?: 'blank-continuation' | 'final-tool';
  } = {},
): RunHistoryDraft {
  const { sourceResponse = null, input, reason } = options;
  return {
    type: 'model.message',
    aggregateId: rowAggregate(runId),
    payload: {
      kind: 'append',
      messages,
      sourceResponse,
      ...(input !== undefined && Object.keys(input).length > 0 && { input }),
      ...(reason !== undefined && { reason }),
    },
  };
}

/**
 * The run's `run.config` on `model` and `binding`: the configuration the run
 * was launched (or resumed) with, and what the loop bound, written when the
 * run first binds and at a model switch, in the batch that puts the binding
 * in force.
 */
export function configRow(
  runId: RunId,
  config: RunRecord,
  model: string,
  binding: RunBinding,
): RunHistoryDraft {
  return {
    type: 'run.config',
    aggregateId: rowAggregate(runId),
    config: { ...config, model },
    binding,
  };
}

/** Each arm of a draft union keeps its own required fields. */
type Unqualified<T> = T extends unknown ? Omit<T, 'aggregateId'> : never;

/** A display row the loop commits atomically with a run history row: the card a
 *  tool call opens, closes, or both, in the batch that settles it. */
export function displayRow(
  runId: RunId,
  draft: Unqualified<
    Extract<SessionEventDraft, { type: 'tool.start' | 'tool.end' }>
  >,
): RunHistoryDraft {
  return { ...draft, aggregateId: rowAggregate(runId) };
}

/** The tool a script's run calls: `script`, whatever launched the run. */
const SCRIPT_TOOL_NAME = 'script';

/**
 * The row of a script's run's one call (`AgentConfig.script`): the call the
 * application handed it, which no model produced, so it records no attempt,
 * origin or usage. It stands as the pending response the loop dispatches.
 * Committed once, in the run's opening batch.
 */
export const handedDown = Effect.fn('rows.handedDown')(function* (
  run: Pick<AgentRunShape, 'steps' | 'logger' | 'runId'>,
  call: NonNullable<AgentRunShape['config']['script']>,
) {
  const { runId } = run;
  const argumentsText = JSON.stringify({
    code: call.code,
    title: call.title,
    ...(call.timeoutMs != null && { timeoutMs: call.timeoutMs }),
  });
  const [facts] = dispatchFactsFor(
    [{ callId: SCRIPT_CALL_ID, name: SCRIPT_TOOL_NAME, argumentsText }],
    (yield* SynchronizedRef.get(run.steps))?.tools.registry,
    run.logger,
    generateShortId,
  );
  if (facts === undefined)
    return yield* Effect.die(new Error('One call in, one dispatch fact out.'));
  return {
    type: 'model.message',
    aggregateId: rowAggregate(runId),
    payload: {
      kind: 'handed-down',
      responseId: randomUUID(),
      call: facts,
      argumentsText,
    },
  } satisfies RunHistoryDraft;
});

/** The call id of a script run's one call (`AgentConfig.script`): its
 *  nested calls are `script/<seq>`. */
const SCRIPT_CALL_ID = 'script';

/** The `followup.consumed` rows of the run's pending requests of `kind`,
 *  or of every kind. */
export const consumedRows = (
  runId: RunId,
  controls: readonly QueuedFollowUp[],
  kind?: NonNullable<QueuedFollowUp['control']>['kind'],
): Extract<RunHistoryDraft, { type: 'followup.consumed' }>[] =>
  controls.flatMap(({ followUpId, control }) =>
    control !== undefined && (kind === undefined || control.kind === kind)
      ? [
          {
            type: 'followup.consumed' as const,
            aggregateId: rowAggregate(runId),
            followUpId,
          },
        ]
      : [],
  );
