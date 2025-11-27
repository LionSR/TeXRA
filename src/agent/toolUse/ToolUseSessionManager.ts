/**
 * Re-exports for tool-use session management.
 *
 * This module provides the public API for session snapshot management:
 * - ToolUseSessionManager: Primary class for in-memory snapshot caching
 * - ToolUseSnapshotCache: Deprecated alias (use ToolUseSessionManager)
 * - Type exports for snapshot payloads
 */

export {
  ToolUseSessionManager,
  ToolUseSnapshotCache,
} from './ToolUseSnapshotCache';

export type {
  ToolUseSessionSnapshot,
  SaveToolUseSnapshotPayload,
} from './ToolUseSnapshotTypes';
