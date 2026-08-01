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

/**
 * The machine's single per-stream entry map. Seeding writes the settled
 * `phase` form directly, which also replaces any reservation on that stream.
 */
interface StreamStatusMachineInternals {
  readonly streams: Map<
    StreamTabId,
    {
      readonly kind: 'phase';
      readonly state: {
        readonly phase: StreamPhase;
        readonly substate?: StreamSubstate;
      };
    }
  >;
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
  const { streams } = internals(machine);
  if (status === STREAM_STATUS.READY) {
    streams.delete(streamId);
    return;
  }

  const phase = StreamPhaseSchema.safeParse(status);
  const substate = phase.success
    ? undefined
    : streamStatusToSubstate(status as StreamStatus);
  streams.set(streamId, {
    kind: 'phase',
    state: {
      phase: phase.success
        ? phase.data
        : streamStatusToPhase(status as StreamStatus),
      ...(substate ? { substate } : {}),
    },
  });
}
