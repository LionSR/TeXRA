// Standard library imports
import * as path from 'path';

// Local imports - storage
import { StorageFS } from './storageFS';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

export const TASK_RUNS_DIR = 'taskRuns';

export function getRunDir(id: ExecutionId): string {
  return StorageFS.fullPath(path.join(TASK_RUNS_DIR, id));
}

export async function ensureRunDir(id: ExecutionId): Promise<void> {
  await StorageFS.ensureDir(TASK_RUNS_DIR);
  await StorageFS.ensureDir(path.join(TASK_RUNS_DIR, id));
}
