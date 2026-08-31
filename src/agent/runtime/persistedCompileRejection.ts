import { getExecutionStore } from '@agent/storage';
import { readPersistedFlowRecord } from '@agent/node/persistedFlow';
import type { ExecutionId } from '@shared/schemas';

const LEGACY_FINAL_COMPILE_REJECTION_MESSAGE =
  'Automatic LaTeX compilation failed after the final workflow round.';

/** Whether persisted state records an unresolved compile rejection. */
export function hasPersistedCompileRejection(shared: unknown): boolean {
  if (typeof shared !== 'object' || shared === null) return false;
  const state = shared as Record<string, unknown>;
  if (state.unresolvedCompileRejection === true) return true;
  return (
    state.unresolvedCompileRejection === undefined &&
    typeof state.compileFailureContext === 'string' &&
    state.compileFailureContext.length > 0
  );
}

/** Whether persisted compile rejection has reached the configured round cap. */
export function isTerminalPersistedCompileRejection(shared: unknown): boolean {
  if (!hasPersistedCompileRejection(shared)) return false;
  const state = shared as Record<string, unknown>;
  return (
    typeof state.currentRound === 'number' &&
    typeof state.totalRounds === 'number' &&
    state.currentRound + 1 >= state.totalRounds
  );
}

/** Read an execution's persisted workflow state and apply the terminal predicate. */
export async function hasTerminalPersistedCompileRejection(
  id: ExecutionId,
): Promise<boolean> {
  const flowRecord = await readPersistedFlowRecord(getExecutionStore(id), id);
  return isTerminalPersistedCompileRejection(flowRecord?.shared);
}

/** Identify the exact provider-like error synthesized by legacy workflow code. */
export function isLegacySyntheticFinalCompileError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    value.message === LEGACY_FINAL_COMPILE_REJECTION_MESSAGE &&
    value.userRetryable === false
  );
}
