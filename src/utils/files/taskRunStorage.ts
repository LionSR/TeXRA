// Standard library imports
import * as path from 'path';

// Local imports - file utils
import { StorageFS } from './storageFS';

// Local imports - types
import type { ExecutionId } from '@agent/types/IdentifierTypes';

/** Base directory under workspace storage for per-task data. */
export const TASK_RUNS_DIR = 'taskRuns';

/**
 * Get the absolute path to the directory for a specific execution.
 */
export function getRunDir(id: ExecutionId): string {
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, id));
}

/**
 * Ensure the task run directory exists, along with the base directory.
 */
export async function ensureRunDir(id: ExecutionId): Promise<void> {
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  await StorageFS.ensureDir(path.join(TASK_RUNS_DIR, id));
}
