// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type { ProgressEventBusLike } from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'ApprovalEvents';

/**
 * Callbacks for approval event handling.
 */
export interface ApprovalCallbacks {
  showToolEditApprovalPrompt: (
    payload: ProgressEventPayloads['showToolEditApprovalPrompt'],
  ) => void;
  resolveToolEditApprovalPrompt: (requestId: string) => void;
  updateToolEditApprovalBypassState: (bypassActive: boolean) => void;
}

/**
 * Register approval event handlers.
 */
export function registerApprovalEvents(
  bus: ProgressEventBusLike,
  callbacks: ApprovalCallbacks,
): vscode.Disposable[] {
  return [
    new vscode.Disposable(
      bus.on('showToolEditApprovalPrompt', (payload) =>
        withEventErrorHandling(MODULE, 'failed to show approval prompt', () =>
          callbacks.showToolEditApprovalPrompt(payload),
        ),
      ),
    ),
    new vscode.Disposable(
      bus.on('resolveToolEditApprovalPrompt', (payload) =>
        withEventErrorHandling(
          MODULE,
          'failed to resolve approval prompt',
          () => callbacks.resolveToolEditApprovalPrompt(payload.requestId),
        ),
      ),
    ),
    new vscode.Disposable(
      bus.on('updateToolEditApprovalBypassState', (payload) =>
        withEventErrorHandling(
          MODULE,
          'failed to update approval bypass state',
          () => callbacks.updateToolEditApprovalBypassState(payload.bypassActive),
        ),
      ),
    ),
  ];
}
