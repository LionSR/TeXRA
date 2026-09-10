import type {
  RunPhaseState,
  RunStatusMachine,
} from '@agent/runtime/StreamStatusService';
import type { StreamTabId } from '@shared/schemas';

/**
 * The machine's single per-stream entry map. Seeding writes the settled
 * `phase` form directly.
 */
interface StreamStatusMachineInternals {
  readonly streams: Map<
    StreamTabId,
    { readonly kind: 'phase'; readonly state: RunPhaseState }
  >;
}

function internals(machine: RunStatusMachine): StreamStatusMachineInternals {
  return machine as unknown as StreamStatusMachineInternals;
}

export function clearStreamStatusForTest(
  machine: RunStatusMachine,
  streamId: StreamTabId,
): void {
  machine.clearStream(streamId);
}

export function clearAllStreamStatusesForTest(machine: RunStatusMachine): void {
  machine.clearAll();
}

export function seedStreamStatusForTest(
  machine: RunStatusMachine,
  streamId: StreamTabId,
  state: RunPhaseState,
): void {
  internals(machine).streams.set(streamId, { kind: 'phase', state });
}
