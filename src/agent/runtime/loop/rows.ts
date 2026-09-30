/**
 * The loops' row constructors: every ledger draft a loop appends, built from
 * the folded `RunState` and nothing else. A `run.position` is the one record
 * of where the loop stands; a `run.snapshot` carries the loop state and what
 * the loop runs on (model, failure, declined routes); every fact a row already
 * carries (the pending response, its intents, their approval bindings, the
 * retry permit) is folded from that row and never restated here.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  aggregateId as qualifyAggregateId,
  type PositionAt,
  type RunSnapshotPayload,
  type PendingRetry,
  type RunId,
  type RunOutcome,
  type SessionEventDraft,
  type SnapshotRuntime,
} from '@shared/schemas';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import type { MessageSchema } from '@texra-ai/llm/turn';
import type { z } from 'zod';

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
): RunLedgerDraft {
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

export function haltedPositionRow(
  runId: RunId,
  state: PositionCoordinates,
  outcome: RunOutcome,
): RunLedgerDraft {
  return {
    type: 'run.position',
    aggregateId: rowAggregate(runId),
    payload: {
      family: familyOf(state),
      at: 'halted',
      turn: state.turn,
      outcome,
    },
  };
}

export function appendRow(
  runId: RunId,
  messages: readonly Message[],
  sourceResponse: string | null = null,
): RunLedgerDraft {
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
      'modelId' | 'modelCompatibilityKey' | 'lastError' | 'declinedRoutes'
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
): readonly RunLedgerDraft[] {
  const loop = patch.state ?? state.loop;
  if (loop === null) {
    throw new Error('A run.snapshot presupposes an opened run.');
  }
  // A snapshot's model id is a required durable fact (resume and every
  // listing read it back); no caller may reach here without one, so refuse
  // at the constructor rather than let `appendBatch` reject the batch on a
  // schema refinement far from whatever lost the binding.
  const modelId = patch.runtime?.modelId ?? state.modelId;
  if (modelId === undefined || modelId === null || modelId === '') {
    throw new Error('A run.snapshot presupposes a bound model id.');
  }
  const runtime: SnapshotRuntime = {
    modelId,
    modelCompatibilityKey:
      patch.runtime !== undefined && 'modelCompatibilityKey' in patch.runtime
        ? (patch.runtime.modelCompatibilityKey ?? null)
        : state.modelCompatibilityKey,
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
 * The approval that guards one outcome-unknown call: committed in the batch
 * that opens the request it names, and the one carrier of the binding the
 * fold reads back.
 */
export function bindingRow(
  runId: RunId,
  binding: { callId: string; attempt: number; requestId: string },
): RunLedgerDraft {
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
): RunLedgerDraft {
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
): readonly RunLedgerDraft[] {
  return [retryRow(runId, permit), ...snapshotRow(runId, state, { runtime })];
}

/** Each arm of a draft union keeps its own required fields. */
type Unqualified<T> = T extends unknown ? Omit<T, 'aggregateId'> : never;

/** A display row the loop commits atomically with a ledger row: the card a
 *  tool call opens, closes, or both, in the batch that settles it. */
export function displayRow(
  runId: RunId,
  draft: Unqualified<
    Extract<SessionEventDraft, { type: 'tool.start' | 'tool.end' }>
  >,
): RunLedgerDraft {
  return { ...draft, aggregateId: rowAggregate(runId) };
}
