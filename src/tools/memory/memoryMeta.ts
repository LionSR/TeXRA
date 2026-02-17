/**
 * Attribution metadata for memory files.
 *
 * Stores who last modified each file in a sidecar JSON file so that
 * directory listings can show provenance without polluting file content.
 */
import * as path from 'path';

import { StorageFS } from '@utils/files';

import { MEMORY_META_FILE, MEMORY_STORAGE_ROOT } from './constants';

export interface MemoryFileMeta {
  /** Agent name that last modified this file. */
  modifiedBy: string;
  /** Execution ID of the run that last modified this file. */
  executionId?: string;
  /** ISO 8601 timestamp of last modification. */
  modifiedAt: string;
}

type MetaMap = Record<string, MemoryFileMeta>;

/** Read the metadata map, returning empty object on missing/corrupt file. */
async function readMeta(): Promise<MetaMap> {
  try {
    return await StorageFS.readJson<MetaMap>(MEMORY_META_FILE);
  } catch {
    return {};
  }
}

/** Persist the metadata map. */
async function writeMeta(meta: MetaMap): Promise<void> {
  await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
  await StorageFS.writeJson(MEMORY_META_FILE, meta);
}

/** Convert a resolved storage path to a meta key (relative to memories/). */
function toMetaKey(storagePath: string): string {
  return path.relative(MEMORY_STORAGE_ROOT, storagePath);
}

/** Record that an agent modified a file. No-op if agentName is undefined. */
export async function recordAttribution(
  storagePath: string,
  agentName: string | undefined,
  executionId: string | undefined,
): Promise<void> {
  if (!agentName) return;
  const meta = await readMeta();
  meta[toMetaKey(storagePath)] = {
    modifiedBy: agentName,
    executionId,
    modifiedAt: new Date().toISOString(),
  };
  await writeMeta(meta);
}

/** Remove metadata for a deleted file. */
export async function removeAttribution(storagePath: string): Promise<void> {
  const meta = await readMeta();
  const key = toMetaKey(storagePath);
  if (key in meta) {
    delete meta[key];
    await writeMeta(meta);
  }
}

/** Update metadata key after a rename. */
export async function renameAttribution(
  oldStoragePath: string,
  newStoragePath: string,
  agentName: string | undefined,
  executionId: string | undefined,
): Promise<void> {
  const meta = await readMeta();
  const oldKey = toMetaKey(oldStoragePath);
  const newKey = toMetaKey(newStoragePath);
  const existing = meta[oldKey];
  delete meta[oldKey];
  meta[newKey] = {
    modifiedBy: agentName ?? existing?.modifiedBy ?? 'unknown',
    executionId: executionId ?? existing?.executionId,
    modifiedAt: new Date().toISOString(),
  };
  await writeMeta(meta);
}

/** Look up attribution for a storage path. */
export async function getAttribution(
  storagePath: string,
): Promise<MemoryFileMeta | undefined> {
  const meta = await readMeta();
  return meta[toMetaKey(storagePath)];
}

/** Bulk-read all attributions (keyed by storage-relative path). */
export async function getAllAttributions(): Promise<MetaMap> {
  return readMeta();
}

/** Format attribution for display: "agentName (executionId)" or just "agentName". */
export function formatAttribution(meta: MemoryFileMeta): string {
  return meta.executionId
    ? `${meta.modifiedBy} (${meta.executionId})`
    : meta.modifiedBy;
}
