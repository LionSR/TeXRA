// Local imports
import { ExecutionLeaseSchema } from '@agent/storage/executionLease';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { StorageFS } from '@utils/files/storageFS';

/**
 * A lease owner that is never this process: local ownership always uses a
 * freshly generated UUID, so a fixed token reads back as foreign ownership.
 */
const FOREIGN_OWNER_TOKEN = '00000000-0000-4000-8000-000000000001';

/** Storage-relative path of an execution's persisted lease record. */
export function executionLeasePath(executionId: string): string {
  return `${WORKSPACE_STORAGE_LAYOUT.executionLeases}/${executionId}.json`;
}

/**
 * Persist a lease held by another process, validated against the production
 * lease schema so a schema change breaks every fixture in one place.
 */
export async function writeForeignLease(
  executionId: string,
  heartbeatAt: number = Date.now(),
  ownerToken: string = FOREIGN_OWNER_TOKEN,
): Promise<void> {
  const lease = ExecutionLeaseSchema.parse({
    version: 1,
    executionId,
    ownerToken,
    acquiredAt: heartbeatAt,
    heartbeatAt,
  });
  await StorageFS.ensureDir(WORKSPACE_STORAGE_LAYOUT.executionLeases);
  await StorageFS.writeAtomic(
    executionLeasePath(executionId),
    JSON.stringify(lease),
  );
}
