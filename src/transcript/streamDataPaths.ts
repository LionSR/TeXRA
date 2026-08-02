/**
 * Shared on-disk layout for per-stream sidecar data (`streamData/`).
 *
 * Host-agnostic so the CLI TUI, VS Code extension, and Electron desktop app
 * all produce a byte-identical `streamData/{encodeStreamId(streamId)}/…`
 * subtree under their respective platform storage roots. Only the absolute
 * root differs per host; this relative layout is the same everywhere, which is
 * what lets a session render/resume identically across hosts and keeps the
 * future cross-host shared-root flip a configuration change, not a format one.
 *
 * The per-category file keys live here too so the shared `StreamSnapshotStore`
 * and every host write the same filenames.
 */

import * as path from 'node:path';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';

/** Root directory (relative to the platform storage root) for per-stream sidecar data. */
export const STREAM_DATA_DIR = WORKSPACE_STORAGE_LAYOUT.streamData;
/**
 * Reversible staging area for snapshot directories while transcript deletion
 * decides whether a stream removal commits.
 */
export const STREAM_DATA_DELETION_DIR = `${STREAM_DATA_DIR}.deleting`;

/**
 * Per-category file keys within a stream's `streamData/{id}/` directory.
 *
 * The first five already exist on disk for extension users; `WORK_PLAN` is the
 * one new file — todos/plan have no other durable home (they are ephemeral in
 * every host today and are not recorded in the StreamLog).
 */
export const STREAM_DATA_KEYS = {
  META: 'meta',
  OUTPUT_FILES: 'outputFiles',
  MISSING_OUTPUTS: 'missingOutputs',
  COMPILE_FAILURES: 'compileFailures',
  USAGE_STATS: 'usageStats',
  /** NEW — durable todos/plan/planSummary. */
  WORK_PLAN: 'workPlan',
} as const;

/**
 * Encode a stream tab id for safe use as a filesystem directory name.
 * Stream ids can contain `:`, `/`, `#`, and other unsafe characters.
 */
function encodeStreamId(id: string): string {
  return encodeURIComponent(id);
}

const RESERVED_STREAM_DATA_SEGMENTS = new Set(['', '.', '..']);

export function canUseStreamDataDir(streamId: string): boolean {
  try {
    return !RESERVED_STREAM_DATA_SEGMENTS.has(encodeStreamId(streamId));
  } catch {
    // Malformed UTF-16 cannot be encoded into a stream-owned sidecar segment.
    return false;
  }
}

/** Decode a persisted stream directory name. Invalid legacy names are skipped. */
export function decodeStreamId(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** Build the relative directory path for a stream's sidecar data: `streamData/{encoded}`. */
export function streamDataDir(streamId: string): string {
  return path.join(STREAM_DATA_DIR, encodeStreamId(streamId));
}

/** Build the reversible staging path for one stream's snapshot directory. */
export function stagedStreamDataDir(streamId: string): string {
  return path.join(STREAM_DATA_DELETION_DIR, encodeStreamId(streamId));
}
