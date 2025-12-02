// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { ToolEditApprovalPrompt } from '@progressView/types';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

export interface ToolEditApprovalEventsShared {
  logger: AgentLogger;
  /** Callback to show tool edit approval prompt (routes through provider for queueing) */
  showToolEditApprovalPrompt: (payload: ToolEditApprovalPrompt) => void;
  /** Callback to resolve tool edit approval prompt (routes through provider for queueing) */
  resolveToolEditApprovalPrompt: (requestId: string) => void;
  /** Callback to update tool edit approval bypass state */
  updateToolEditApprovalBypassState: (bypassActive: boolean) => void;
}

export interface ToolEditApprovalEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
  ): vscode.Disposable[];
}

/**
 * Creates a module for handling tool edit approval events.
 * Follows the established event module pattern used by RetryEvents, LogEvents, etc.
 */
export function createToolEditApprovalEventsModule(
  shared: ToolEditApprovalEventsShared,
): ToolEditApprovalEventsModule {
  const withErrorBoundary = createErrorBoundary(
    shared.logger,
    'ToolEditApprovalEvents',
  );

  return {
    register(
      bus: ProgressEventBusLike,
      _state: ProgressViewState,
    ): vscode.Disposable[] {
      return [
        new vscode.Disposable(
          bus.on('showToolEditApprovalPrompt', (payload) =>
            withErrorBoundary('failed to show tool edit approval prompt', () =>
              shared.showToolEditApprovalPrompt(payload),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('resolveToolEditApprovalPrompt', (payload) =>
            withErrorBoundary(
              'failed to resolve tool edit approval prompt',
              () => shared.resolveToolEditApprovalPrompt(payload.requestId),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('updateToolEditApprovalBypassState', (payload) =>
            withErrorBoundary(
              'failed to update tool edit approval bypass state',
              () =>
                shared.updateToolEditApprovalBypassState(payload.bypassActive),
            ),
          ),
        ),
      ];
    },
  };
}
