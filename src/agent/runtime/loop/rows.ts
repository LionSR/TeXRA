/**
 * The loops' row constructors: every ledger draft a loop appends, built from
 * the folded `RunState` and nothing else. A `flow.snapshot` carries the
 * family state and the coordinates the loop owns; every fact a row already
 * carries (the pending response, its intents, their approval bindings, the
 * retry permit) is folded from that row and never restated here.
 */

import {
  aggregateId as qualifyAggregateId,
  type FlowStep,
  type FlowSnapshotPayload,
  type PendingRetry,
  type PermissionPayload,
  type RunId,
  type RunLoopPhase,
  type RunOutcome,
  type SessionEventDraft,
  type SnapshotRuntime,
} from '@shared/schemas';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import type { MessageSchema } from '@texra-ai/llm/turn';
import type { z } from 'zod';

export type Message = z.infer<typeof MessageSchema>;

export type ToolUseFlowState = FlowSnapshotPayload['state'];

export function rowAggregate(runId: RunId) {
  return qualifyAggregateId('run', runId);
}

/** The coordinates a `flow.step` row is stamped with. */
export type StepCoordinates = Pick<RunState, 'family' | 'round' | 'turn'>;

/** A step never lands on an unopened run: the family is the state's. */
function familyOf(
  state: Pick<RunState, 'family'>,
): FlowSnapshotPayload['family'] {
  if (state.family === null) {
    throw new Error('A flow.step presupposes an opened run with a family.');
  }
  return state.family;
}

export function stepRow(
  runId: RunId,
  state: StepCoordinates,
  step: Exclude<FlowStep, 'halted'>,
): RunLedgerDraft {
  return {
    type: 'flow.step',
    aggregateId: rowAggregate(runId),
    payload: {
      family: familyOf(state),
      step,
      round: state.round,
      turn: state.turn,
    },
  };
}

export function haltedStepRow(
  runId: RunId,
  state: StepCoordinates,
  outcome: RunOutcome,
): RunLedgerDraft {
  return {
    type: 'flow.step',
    aggregateId: rowAggregate(runId),
    payload: {
      family: familyOf(state),
      step: 'halted',
      round: state.round,
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
  /** Defaults to the folded phase: the runtime-only case. */
  readonly phase?: RunLoopPhase;
  readonly round?: number;
  readonly turn?: number;
  readonly runtime?: Partial<
    Pick<
      SnapshotRuntime,
      'modelId' | 'modelCompatibilityKey' | 'lastError' | 'declinedRoutes'
    >
  >;
  /** Defaults to the flow state the run last wrote. */
  readonly state?: ToolUseFlowState;
}

/**
 * The one `flow.snapshot` constructor. Coordinates and runtime fields come
 * from the folded state unless the patch moves them; the flow state is the
 * one the run last wrote unless the patch rewrites it.
 */
export function snapshotRow(
  runId: RunId,
  state: RunState,
  patch: SnapshotPatch,
): RunLedgerDraft {
  const flow = patch.state ?? state.flow?.state ?? null;
  const phase = patch.phase ?? state.phase;
  if (flow === null || phase === null) {
    throw new Error('A flow.snapshot presupposes an opened run.');
  }
  // A snapshot's model id is a required durable fact (resume and every
  // listing read it back); no caller may reach here without one, so refuse
  // at the constructor rather than let `appendBatch` reject the batch on a
  // schema refinement far from whatever lost the binding.
  const modelId = patch.runtime?.modelId ?? state.modelId;
  if (modelId === undefined || modelId === null || modelId === '') {
    throw new Error('A flow.snapshot presupposes a bound model id.');
  }
  const runtime: SnapshotRuntime = {
    phase,
    round: patch.round ?? state.round,
    turn: patch.turn ?? state.turn,
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
  return {
    type: 'flow.snapshot',
    aggregateId: rowAggregate(runId),
    payload: { family: 'toolUse', runtime, state: flow },
  };
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
  return [retryRow(runId, permit), snapshotRow(runId, state, { runtime })];
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

/**
 * The durable copy of an approval request payload. A retry carries the
 * provider error, whose raw body is dropped before the row is written; the
 * rest of the payload is written as it is. Every writer of a
 * `request.opened` row passes its payload through here, whether the session
 * opens the request or a loop commits it with its recovery binding.
 */
export function redactedForFact(payload: PermissionPayload): PermissionPayload {
  if (payload.kind !== 'retry') return payload;
  const { errorDetails, ...data } = payload.data;
  if (!errorDetails) return payload;
  const { rawErrorBody: _dropped, ...details } = errorDetails;
  return { kind: 'retry', data: { ...data, errorDetails: details } };
}
