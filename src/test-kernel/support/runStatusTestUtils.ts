import type {
  RunPhaseState,
  RunStatusMachine,
} from '@agent/runtime/RunStatusService';
import type { RunId } from '@shared/schemas';

/**
 * The machine's single per-stream entry map. Seeding writes the settled
 * `phase` form directly.
 */
interface RunStatusMachineInternals {
  readonly runs: Map<
    RunId,
    { readonly kind: 'phase'; readonly state: RunPhaseState }
  >;
}

function internals(machine: RunStatusMachine): RunStatusMachineInternals {
  return machine as unknown as RunStatusMachineInternals;
}

export function clearRunStatusForTest(
  machine: RunStatusMachine,
  runId: RunId,
): void {
  machine.clearRun(runId);
}

export function clearAllRunStatusesForTest(machine: RunStatusMachine): void {
  machine.clearAll();
}

export function seedRunStatusForTest(
  machine: RunStatusMachine,
  runId: RunId,
  state: RunPhaseState,
): void {
  internals(machine).runs.set(runId, { kind: 'phase', state });
}
