/** The small value and usage operations shared by both run programs. */

import { Effect, SynchronizedRef } from 'effect';

import {
  AgentRunStateSnapshotSchema,
  type AgentRunStateSnapshot,
  type FlowSnapshotPayload,
  type NormalizedUsage,
  type RunId,
} from '@shared/schemas';
import { freshRunState, type RunState } from '@shared/session/runStateFold';

import type { AgentRunShape } from '../run/AgentRun';
import type { BoundModel } from '../run/modelBinding';

/** Refuse a fresh launch when the ledger already holds an opened run. */
export const alreadyOpenedMessage = (runId: RunId): string =>
  `Run ${runId} already has ledger state; resume it instead.`;

/** Charge the binding that served a turn, including one rebound by a retry. */
export const recordServedUsage = (
  run: Pick<AgentRunShape, 'model' | 'usageMonitor'>,
  snapshot: AgentRunStateSnapshot,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const served = yield* SynchronizedRef.get(run.model);
    yield* Effect.sync(() => run.usageMonitor.recordUsage(snapshot, served));
  });

/** The opening snapshot records the launch's binding and route choice. */
export function freshProgramState(
  family: FlowSnapshotPayload['family'],
  bound: BoundModel,
  run: Pick<AgentRunShape, 'declinedRoutes'>,
): RunState {
  return {
    ...freshRunState(0),
    family,
    modelId: bound.modelId,
    modelCompatibilityKey: bound.compatibilityKey,
    declinedRoutes: run.declinedRoutes,
  };
}

/** Build the turn's usage record from the ledger's folded totals. */
export function usageSnapshot(
  state: RunState,
  totalRounds: number,
  totalResponseTimeMs: number,
  latestUsage: NormalizedUsage | null,
) {
  return AgentRunStateSnapshotSchema.parse({
    totalRounds,
    totalResponseTimeMs,
    usageAccumulator: { totals: state.usage, latestUsage },
  });
}
