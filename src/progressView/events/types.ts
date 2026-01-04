// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

// ============================================================================
// Event Bus Interface
// ============================================================================

export interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void;
  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Send update to webview only if stream is active and webview is available.
 * Eliminates repetitive isAvailable/activeStream checks in every handler.
 */
export function sendIfActive(
  stream: string,
  state: ProgressViewState,
  updater: WebviewUpdater,
  send: () => void,
): void {
  if (updater.isAvailable() && stream === state.activeStream) {
    send();
  }
}
