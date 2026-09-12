/**
 * The loops' row constructors: every ledger draft a loop appends, built from
 * the folded `RunState` and nothing else. A `flow.snapshot`'s references are
 * derived from the state the ledger returned, which is what lets the fold's
 * reconcile-never-overwrite check hold on every write.
 */

import type { MessageSchema } from '@llm/turn';
import {
  aggregateId as qualifyAggregateId,
  type FlowStep,
  type FlowSnapshotPayload,
  type RunId,
  type RunLoopPhase,
  type RunOutcome,
  type SessionEventDraft,
  type SnapshotRuntime,
} from '@shared/schemas';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import type { z } from 'zod';

export type Message = z.infer<typeof MessageSchema>;

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

type StepCoordinates = Pick<
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
      'modelId' | 'modelHandlerCompatibilityKey' | 'lastError' | 'pendingRetry'
    >
  >;
  /**
   * Approval bindings for outcome-unknown intents, by call id: the snapshot
   * is the one carrier of an intent's `approvalRequestId`, so the batch that
   * commits a `tool-outcome` request names it here.
   */
  readonly intentBindings?: Readonly<Record<string, string>>;
}

export interface SnapshotPatch extends SnapshotCoordinates {
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
  const runtime: SnapshotRuntime = {
    phase: patch.phase,
    round: patch.round ?? state.round,
    turn: patch.turn ?? state.turn,
    continuationIndex: patch.continuationIndex ?? state.continuationIndex,
    modelId:
      patch.runtime?.modelId ??
      state.modelId ??
      (flow.family === 'toolUse' ? flow.state.modelId : undefined) ??
      '',
    modelHandlerCompatibilityKey:
      patch.runtime !== undefined &&
      'modelHandlerCompatibilityKey' in patch.runtime
        ? (patch.runtime.modelHandlerCompatibilityKey ?? null)
        : state.modelHandlerCompatibilityKey,
    lastError:
      patch.runtime !== undefined && 'lastError' in patch.runtime
        ? (patch.runtime.lastError ?? null)
        : state.lastError,
    pendingRetry:
      patch.runtime !== undefined && 'pendingRetry' in patch.runtime
        ? (patch.runtime.pendingRetry ?? null)
        : state.pendingRetry,
  };
  const pending = state.pendingResponse;
  const references = {
    pendingIntents: Object.entries(state.pendingIntents).map(
      ([callId, intent]) => ({
        callId,
        attempt: intent.attempt,
        responseId: intent.responseId,
        approvalRequestId:
          patch.intentBindings?.[callId] ?? intent.approvalRequestId,
      }),
    ),
    pendingResponse:
      pending === null
        ? null
        : {
            responseId: pending.responseId,
            settled: Object.keys(pending.settled),
          },
  };
  return {
    type: 'flow.snapshot',
    aggregateId: rowAggregate(runId),
    payload:
      flow.family === 'toolUse'
        ? { family: flow.family, runtime, references, state: flow.state }
        : { family: flow.family, runtime, references, state: flow.state },
  };
}

/**
 * A `flow.snapshot` for the tool-use family. Coordinates and runtime fields
 * come from the folded state unless the patch moves them; the references
 * are always the folded ones.
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
 * A snapshot that moves only runtime fields (the retry gate, the last error,
 * the model binding) on the family state the run last wrote, for either
 * family: what the invoker commits inside its admission protocol.
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

/** A display row the loop commits atomically with a ledger row. */
export function displayRow(
  runId: RunId,
  draft: Omit<Extract<SessionEventDraft, { type: 'tool.end' }>, 'aggregateId'>,
): RunLedgerDraft {
  return { ...draft, aggregateId: rowAggregate(runId) };
}
