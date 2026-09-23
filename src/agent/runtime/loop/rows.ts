/**
 * The loops' row constructors: every ledger draft a loop appends, built from
 * the folded `RunState` and nothing else. A `flow.snapshot` carries the
 * family state and the coordinates the loop owns; every fact a row already
 * carries (the pending response, its intents, their approval bindings, the
 * retry permit) is folded from that row and never restated here.
 */

import { redactSecrets } from '@logger/redaction';
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

/** Why a run the ledger holds no rows for cannot be continued. Both run
 *  programs refuse a resume with it. */
export const NOT_RESUMABLE_MESSAGE =
  'This run was recorded before the run ledger and is not resumable under this release, and a request it left pending (an approval, a retry, a question) is not resumable either. Start a new run instead.';

type ToolUseSnapshot = Extract<FlowSnapshotPayload, { family: 'toolUse' }>;
type ReflectionSnapshot = Extract<
  FlowSnapshotPayload,
  { family: 'reflection' }
>;
export type ToolUseFlowState = ToolUseSnapshot['state'];
export type ReflectionFlowState = ReflectionSnapshot['state'];

/** The family state a snapshot carries, keyed by its family. */
type FamilyState =
  | { readonly family: 'toolUse'; readonly state: ToolUseFlowState }
  | { readonly family: 'reflection'; readonly state: ReflectionFlowState };

/** The tool-use family state of a folded run, or null before its opening. */
export function toolUseFlowState(state: RunState): ToolUseFlowState | null {
  return state.flow?.family === 'toolUse' ? state.flow.state : null;
}

/** The reflection family state of a folded run, or null before its opening. */
export function reflectionFlowState(
  state: RunState,
): ReflectionFlowState | null {
  return state.flow?.family === 'reflection' ? state.flow.state : null;
}

export function rowAggregate(runId: RunId) {
  return qualifyAggregateId('run', runId);
}

/** The coordinates a `flow.step` row is stamped with. */
export type StepCoordinates = Pick<
  RunState,
  'family' | 'round' | 'turn' | 'continuationIndex'
>;

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
      continuationIndex: state.continuationIndex,
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
      continuationIndex: state.continuationIndex,
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

interface SnapshotCoordinates {
  readonly phase: RunLoopPhase;
  readonly round?: number;
  readonly turn?: number;
  readonly continuationIndex?: number;
  readonly runtime?: Partial<
    Pick<
      SnapshotRuntime,
      'modelId' | 'modelCompatibilityKey' | 'lastError' | 'declinedRoutes'
    >
  >;
}

interface SnapshotPatch extends SnapshotCoordinates {
  readonly state: ToolUseFlowState;
}

export interface ReflectionSnapshotPatch extends SnapshotCoordinates {
  readonly state: ReflectionFlowState;
}

function buildSnapshot(
  runId: RunId,
  state: RunState,
  patch: SnapshotCoordinates,
  flow: FamilyState,
): RunLedgerDraft {
  // A snapshot's model id is a required durable fact (resume and every
  // listing read it back); no caller may reach here without one, so refuse
  // at the constructor rather than let `appendBatch` reject the batch on a
  // schema refinement far from whatever lost the binding.
  const modelId =
    patch.runtime?.modelId ??
    state.modelId ??
    (flow.family === 'toolUse' ? flow.state.modelId : undefined);
  if (modelId === undefined || modelId === null || modelId === '') {
    throw new Error('A flow.snapshot presupposes a bound model id.');
  }
  const runtime: SnapshotRuntime = {
    phase: patch.phase,
    round: patch.round ?? state.round,
    turn: patch.turn ?? state.turn,
    continuationIndex: patch.continuationIndex ?? state.continuationIndex,
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
    payload: { ...flow, runtime },
  };
}

/**
 * A `flow.snapshot` for the tool-use family. Coordinates and runtime fields
 * come from the folded state unless the patch moves them.
 */
export function snapshotRow(
  runId: RunId,
  state: RunState,
  patch: SnapshotPatch,
): RunLedgerDraft {
  return buildSnapshot(runId, state, patch, {
    family: 'toolUse',
    state: patch.state,
  });
}

/** A `flow.snapshot` for the reflection family. */
export function reflectionSnapshotRow(
  runId: RunId,
  state: RunState,
  patch: ReflectionSnapshotPatch,
): RunLedgerDraft {
  return buildSnapshot(runId, state, patch, {
    family: 'reflection',
    state: patch.state,
  });
}

/**
 * A snapshot that moves only runtime fields (the last error, the model
 * binding, the declined routes) on the family state the run last wrote, for
 * either family: what the invoker commits inside its admission protocol.
 */
export function runtimeSnapshotRow(
  runId: RunId,
  state: RunState,
  runtime: NonNullable<SnapshotCoordinates['runtime']>,
): RunLedgerDraft {
  if (state.flow === null || state.phase === null) {
    throw new Error('A runtime snapshot presupposes an opened run.');
  }
  return buildSnapshot(
    runId,
    state,
    { phase: state.phase, runtime },
    state.flow,
  );
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
  return [retryRow(runId, permit), runtimeSnapshotRow(runId, state, runtime)];
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
 * provider error, whose body can echo the request URL or an `Authorization`
 * header, so the raw body is dropped and the text fields are scrubbed before
 * the row is written. Bash commands and question text are what the user
 * typed and stay as they are. Every writer of a `request.opened` row passes
 * its payload through here, whether the session opens the request or a loop
 * commits it with its recovery binding.
 */
export function redactedForFact(payload: PermissionPayload): PermissionPayload {
  if (payload.kind !== 'retry') return payload;
  const { errorMessage, errorDetails, ...data } = payload.data;
  const redactedDetails = (() => {
    if (!errorDetails) return errorDetails;
    const { rawErrorBody: _dropped, ...details } = errorDetails;
    for (const key of ['message', 'statusText', 'partialText'] as const) {
      const value = details[key];
      if (typeof value === 'string') details[key] = redactSecrets(value);
    }
    return details;
  })();
  return {
    kind: 'retry',
    data: {
      ...data,
      ...(errorMessage === undefined
        ? {}
        : { errorMessage: redactSecrets(errorMessage) }),
      ...(redactedDetails === undefined
        ? {}
        : { errorDetails: redactedDetails }),
    },
  };
}
