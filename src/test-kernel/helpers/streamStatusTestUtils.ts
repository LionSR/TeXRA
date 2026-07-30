import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  STREAM_STATUS,
  StreamPhaseSchema,
  type StreamPhase,
  type StreamStatus,
  type StreamSubstate,
  type StreamTabId,
  streamStatusToPhase,
  streamStatusToSubstate,
} from '@shared/schemas';

interface StreamStatusMachineInternals {
  readonly phases: Map<
    StreamTabId,
    { readonly phase: StreamPhase; readonly substate?: StreamSubstate }
  >;
  readonly reservations: Set<StreamTabId>;
}

function internals(machine: StreamStatusMachine): StreamStatusMachineInternals {
  return machine as unknown as StreamStatusMachineInternals;
}

export function clearStreamStatusForTest(
  machine: StreamStatusMachine,
  streamId: StreamTabId,
): void {
  machine.clearStream(streamId);
}

export function clearAllStreamStatusesForTest(
  machine: StreamStatusMachine,
): void {
  machine.clearAll();
}

export function seedStreamStatusForTest(
  machine: StreamStatusMachine,
  streamId: StreamTabId,
  status: StreamPhase | StreamStatus,
): void {
  const state = internals(machine);
  state.reservations.delete(streamId);
  if (status === STREAM_STATUS.READY) {
    state.phases.delete(streamId);
    return;
  }

  const phase = StreamPhaseSchema.safeParse(status);
  const substate = phase.success
    ? undefined
    : streamStatusToSubstate(status as StreamStatus);
  state.phases.set(streamId, {
    phase: phase.success
      ? phase.data
      : streamStatusToPhase(status as StreamStatus),
    ...(substate ? { substate } : {}),
  });
}
