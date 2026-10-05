/**
 * The loops' row constructors: every run history draft a loop appends, built from
 * the folded `RunState` and nothing else. A `run.position` is the one record
 * of where the loop stands; a `run.snapshot` carries the loop state and what
 * the loop runs on (model, failure, declined routes); every fact a row already
 * carries (the pending response, its intents, their approval bindings, the
 * retry permit) is folded from that row and never restated here.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Effect, SynchronizedRef } from 'effect';

import {
  aggregateId as qualifyAggregateId,
  type JsonValue,
  type PositionAt,
  type RunSnapshotPayload,
  type PendingRetry,
  type RunId,
  type RunOutcome,
  type SessionEvent,
  type SessionEventDraft,
  type SnapshotRuntime,
  type ToolBindingPayload,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';
import { generateShortId } from '@utils/core';
import { dispatchFactsFor } from '../run/tools';
import type { MessageSchema } from '@texra-ai/llm';
import type { z } from 'zod';

import type { AgentRunShape } from '../run/AgentRun';
import type { SessionHandle } from '../SessionHandle';

export type Message = z.infer<typeof MessageSchema>;

export type ToolUseLoopState = RunSnapshotPayload['state'];

export function rowAggregate(runId: RunId) {
  return qualifyAggregateId('run', runId);
}

/** The coordinates a `run.position` row is stamped with. */
export type PositionCoordinates = Pick<RunState, 'family' | 'turn'>;

/** A position never lands on an unopened run: the family is the state's. */
function familyOf(
  state: Pick<RunState, 'family'>,
): RunSnapshotPayload['family'] {
  if (state.family === null) {
    throw new Error('A run.position presupposes an opened run with a family.');
  }
  return state.family;
}

export function positionRow(
  runId: RunId,
  state: PositionCoordinates,
  at: Exclude<PositionAt, 'halted'>,
): RunHistoryDraft {
  return {
    type: 'run.position',
    aggregateId: rowAggregate(runId),
    payload: {
      family: familyOf(state),
      at,
      turn: state.turn,
    },
  };
}

/** The loop's halt where its newest position left it, with the run's
 *  outcome: written only with the run's `run.end`, so a stopped run never
 *  reads as interrupted. */
export function haltedPositionRow(
  position: Extract<SessionEvent, { type: 'run.position' }>,
  outcome: RunOutcome,
): SessionEventDraft {
  const { family, turn } = position.payload;
  return {
    type: 'run.position',
    aggregateId: position.aggregateId,
    payload: { family, at: 'halted', turn, outcome },
  };
}

export function appendRow(
  runId: RunId,
  messages: readonly Message[],
  sourceResponse: string | null = null,
): RunHistoryDraft {
  return {
    type: 'model.message',
    aggregateId: rowAggregate(runId),
    payload: { kind: 'append', messages, sourceResponse },
  };
}

export interface SnapshotPatch {
  readonly runtime?: Partial<
    Pick<
      SnapshotRuntime,
      'modelId' | 'backend' | 'lastError' | 'declinedRoutes'
    >
  >;
  /** Defaults to the loop state the run last wrote. */
  readonly state?: ToolUseLoopState;
}

/**
 * The one `run.snapshot` constructor. Runtime fields come from the folded
 * state unless the patch moves them; the loop state is the one the run last
 * wrote unless the patch rewrites it. A snapshot that would record exactly
 * what the latest one written holds is not written: the answer is empty, and
 * a caller spreads it into its batch. The comparison is against that row, not
 * the folded loop state, which a `tool.result` has already moved.
 */
export function snapshotRow(
  runId: RunId,
  state: RunState,
  patch: SnapshotPatch,
): readonly RunHistoryDraft[] {
  const loop = patch.state ?? state.loop;
  if (loop === null) {
    throw new Error('A run.snapshot presupposes an opened run.');
  }
  // A snapshot's model id and backend are required durable facts (resume
  // and every listing read them back); no caller may reach here without
  // them, so refuse at the constructor rather than let `appendBatch` reject
  // the batch on a schema refinement far from whatever lost the binding.
  const modelId = patch.runtime?.modelId ?? state.modelId;
  const backend = patch.runtime?.backend ?? state.backend;
  if (!modelId || backend === null) {
    throw new Error('A run.snapshot presupposes a bound model.');
  }
  const runtime: SnapshotRuntime = {
    modelId,
    backend,
    lastError:
      patch.runtime !== undefined && 'lastError' in patch.runtime
        ? (patch.runtime.lastError ?? null)
        : state.lastError,
    declinedRoutes: patch.runtime?.declinedRoutes ?? state.declinedRoutes,
  };
  const payload: RunSnapshotPayload = {
    family: 'toolUse',
    runtime,
    state: loop,
  };
  if (isDeepStrictEqual(payload, state.lastSnapshot)) return [];
  return [{ type: 'run.snapshot', aggregateId: rowAggregate(runId), payload }];
}

/**
 * The request that guards one call attempt: committed in the batch that
 * opens the request it names, and the one carrier of the binding the fold
 * reads back.
 */
export function bindingRow(
  runId: RunId,
  binding: ToolBindingPayload,
): RunHistoryDraft {
  return {
    type: 'tool.binding',
    aggregateId: rowAggregate(runId),
    payload: binding,
  };
}

/** The retry owner's durable gate, its one carrier: `null` retires it. */
export function retryRow(
  runId: RunId,
  permit: PendingRetry | null,
): RunHistoryDraft {
  return {
    type: 'model.retry',
    aggregateId: rowAggregate(runId),
    payload: { permit },
  };
}

/** One move of the retry gate: the permit on its own row, and the failure it
 *  presents on the snapshot that owns `lastError`. */
export function retryRows(
  runId: RunId,
  state: RunState,
  permit: PendingRetry | null,
  runtime: Partial<Pick<SnapshotRuntime, 'lastError' | 'declinedRoutes'>>,
): readonly RunHistoryDraft[] {
  return [retryRow(runId, permit), ...snapshotRow(runId, state, { runtime })];
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
 * Committed once, at its first turn.
 */
export const handedDown = Effect.fn('rows.handedDown')(function* (
  run: Pick<AgentRunShape, 'steps' | 'logger' | 'runId'>,
  state: RunState,
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
  return [
    {
      type: 'model.message',
      aggregateId: rowAggregate(runId),
      payload: {
        kind: 'handed-down',
        responseId: randomUUID(),
        call: facts,
        argumentsText,
      },
    },
    positionRow(runId, state, 'response.ready'),
  ] satisfies readonly RunHistoryDraft[];
});

/** The call id of a script run's one call (`AgentConfig.script`): its
 *  nested calls are `script/<seq>`. */
const SCRIPT_CALL_ID = 'script';

/** How a script's run's one call settled, as its journaled row says. */
interface ScriptSettlement {
  readonly failed: boolean;
  /** A failed script's error, the run's reply. */
  readonly reply: string;
  /** What the script returned, the run's structured value (a document
   *  task's documents). */
  readonly value: JsonValue | undefined;
}

/** The settlement of `runId`'s script call; null before it settled. */
export const scriptSettlement = Effect.fn('toolUse.scriptSettlement')(
  function* (
    session: Pick<SessionHandle, 'readAggregate'>,
    runId: RunId,
  ): Effect.fn.Return<ScriptSettlement | null, DatabaseReadFailed> {
    const rows = yield* session.readAggregate(rowAggregate(runId), [
      'tool.result',
    ]);
    const settled = rows.findLast(
      (row) =>
        row.type === 'tool.result' && row.payload.callId === SCRIPT_CALL_ID,
    );
    if (settled?.type !== 'tool.result') return null;
    const { result } = settled.payload;
    return result.status === 'error'
      ? { failed: true, reply: result.error, value: undefined }
      : { failed: false, reply: '', value: result.value };
  },
);

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
