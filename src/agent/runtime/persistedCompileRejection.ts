import { getExecutionStore } from '@agent/storage';
import { readPersistedFlowRecord } from '@agent/node/persistedFlow';
import type { ExecutionId } from '@shared/schemas';
import { isObject } from '@utils/core';

const LEGACY_FINAL_COMPILE_REJECTION_MESSAGE =
  'Automatic LaTeX compilation failed after the final workflow round.';

/** Whether persisted state records an unresolved compile rejection. */
export function hasPersistedCompileRejection(shared: unknown): boolean {
  if (!isObject(shared)) return false;
  if (shared.unresolvedCompileRejection === true) return true;
  return (
    shared.unresolvedCompileRejection === undefined &&
    typeof shared.compileFailureContext === 'string' &&
    shared.compileFailureContext.length > 0
  );
}

/** Whether persisted compile rejection has reached the configured round cap. */
export function isTerminalPersistedCompileRejection(shared: unknown): boolean {
  if (!isObject(shared) || !hasPersistedCompileRejection(shared)) return false;
  return (
    typeof shared.currentRound === 'number' &&
    typeof shared.totalRounds === 'number' &&
    shared.currentRound + 1 >= shared.totalRounds
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
  if (!isObject(error)) return false;
  return (
    Object.keys(error).length === 2 &&
    error.message === LEGACY_FINAL_COMPILE_REJECTION_MESSAGE &&
    error.userRetryable === false
  );
}
