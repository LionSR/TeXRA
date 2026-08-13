import type {
  StreamPhaseState,
  StreamStatusMachine,
} from '@agent/runtime/StreamStatusService';
import type { StreamTabId } from '@shared/schemas';

/**
 * The machine's single per-stream entry map. Seeding writes the settled
 * `phase` form directly, which also replaces any reservation on that stream.
 */
interface StreamStatusMachineInternals {
  readonly streams: Map<
    StreamTabId,
    { readonly kind: 'phase'; readonly state: StreamPhaseState }
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
  state: StreamPhaseState,
): void {
  internals(machine).streams.set(streamId, { kind: 'phase', state });
}
