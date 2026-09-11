import { getRunStore } from '@agent/storage';
import { readPersistedFlowRecord } from '@agent/node/persistedFlow';
import type { RunId } from '@shared/schemas';
import { isObject } from '@utils/core';

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

/** Read a run's persisted workflow state and apply the terminal predicate. */
export async function hasTerminalPersistedCompileRejection(
  id: RunId,
): Promise<boolean> {
  const flowRecord = await readPersistedFlowRecord(getRunStore(id), id);
  return isTerminalPersistedCompileRejection(flowRecord?.shared);
}
