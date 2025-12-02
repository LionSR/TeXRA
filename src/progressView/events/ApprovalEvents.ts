// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

export interface ApprovalEventsShared {
  logger: AgentLogger;
  showToolEditApprovalPrompt: (
    payload: ProgressEventPayloads['showToolEditApprovalPrompt'],
  ) => void;
  resolveToolEditApprovalPrompt: (requestId: string) => void;
  updateToolEditApprovalBypassState: (bypassActive: boolean) => void;
}

export interface ApprovalEventsModule {
  register(bus: ProgressEventBusLike): vscode.Disposable[];
}

/**
 * Creates a module for handling tool edit approval events.
 * Follows the established event module pattern used by RetryEvents.
 */
export function createApprovalEventsModule(
  shared: ApprovalEventsShared,
): ApprovalEventsModule {
  const withErrorBoundary = createErrorBoundary(
    shared.logger,
    'ApprovalEvents',
  );

  return {
    register(bus: ProgressEventBusLike): vscode.Disposable[] {
      return [
        new vscode.Disposable(
          bus.on('showToolEditApprovalPrompt', (payload) =>
            withErrorBoundary('failed to show approval prompt', () =>
              shared.showToolEditApprovalPrompt(payload),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('resolveToolEditApprovalPrompt', (payload) =>
            withErrorBoundary('failed to resolve approval prompt', () =>
              shared.resolveToolEditApprovalPrompt(payload.requestId),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('updateToolEditApprovalBypassState', (payload) =>
            withErrorBoundary('failed to update approval bypass state', () =>
              shared.updateToolEditApprovalBypassState(payload.bypassActive),
            ),
          ),
        ),
      ];
    },
  };
}
