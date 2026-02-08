/**
 * Lit context definitions for ProgressView.
 *
 * Context values use types from the store and shared schemas.
 */

// Third-party imports
import { createContext } from '@lit/context';

// Local imports - progress view
import type { FollowupOptionsState, StreamState } from '../store';

// Local imports - progress view components
import type { PermissionState } from '../components/PermissionCard';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

/** Context value for stream state, providing all data needed by stream content components. */
export interface StreamContextValue {
  streamInfo: StreamTabInfo | null;
  streamState: StreamState | null;
  runId: string | null;
  followupOptions: FollowupOptionsState | null;
  /** Pre-computed stream type flag - true for tool-use, false for workflow */
  isToolUse: boolean;
  /** Whether there are any streams in the current filter (for placeholder logic) */
  hasStreams: boolean;
}

/** Default empty stream context value. */
export const EMPTY_STREAM_CONTEXT: StreamContextValue = {
  streamInfo: null,
  streamState: null,
  runId: null,
  followupOptions: null,
  isToolUse: false,
  hasStreams: false,
};

export const streamStateContext = createContext<StreamContextValue>(
  'progress-stream-state',
);

export const permissionsContext = createContext<PermissionState[]>(
  'progress-permissions',
);
