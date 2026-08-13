// Test support imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import type { ProgressHostInteractionsOptions } from '@controllers/progressView/backend/progressHostInteractions';
import { createAgentPresentationHost } from '@frontend/events/agentEventListeners';
import { createExtensionHostInteractions } from '@progressView/extensionHostInteractions';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { ToolEditPermission } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

// Local file imports
import { createRecordingApprovalHandlers } from './approvalHandlerSetHarness';

/**
 * The extension's `HostInteractions.emit` is a thin pass-through to a
 * caller-supplied presentation host, so redelivery is owned elsewhere. These
 * tests pin the two guarantees that ownership has to keep:
 *
 *  1. A pending tool-edit approval redisplays exactly once per webview
 *     reload, and never redisplays once resolved, from
 *     `ApprovalRequestHandler`'s pending/delivered bookkeeping.
 *  2. A presentation event emitted before any host attaches (the launch
 *     path, before `ProgressViewProvider` is constructed) is not lost: the
 *     runtime's `replayWhenAttached` queue replays it exactly once when the
 *     presentation host attaches.
 */

const mocks = vi.hoisted(() => ({
  getLinterMessages: vi.fn(async () => []),
  pushManualCriticism: vi.fn(() => true),
}));

vi.mock('@frontend/latex/linter', () => ({
  getLinterMessages: mocks.getLinterMessages,
}));

vi.mock('@frontend/latex/inlineCriticism', () => ({
  pushManualCriticism: mocks.pushManualCriticism,
}));

function toolEditPermission(requestId: string): ToolEditPermission {
  return {
    requestId,
    allowBypass: true,
    streamId: 'stream-a',
    path: '/workspace/paper.tex',
    relativePath: 'paper.tex',
    sourceTool: 'edit_file',
    addedLines: 1,
    removedLines: 0,
    isLatex: true,
  };
}

const testSessions: SessionHandle[] = [];

afterEach(() => {
  for (const session of testSessions.splice(0)) session.dispose();
});

describe('extension presentation-event emit port (#9251 replay gate)', () => {
  it('redisplays a pending tool-edit approval exactly once per webview reload', () => {
    let canSend = false;
    const sendShow = vi.fn();
    const sendDismiss = vi.fn();
    const toolEdit = new ApprovalRequestHandler<
      ToolEditPermission,
      'requestId'
    >('requestId', sendShow, sendDismiss, () => canSend);
    // The webview is not ready, so the host-local approval handler records the
    // prompt without delivering it.
    toolEdit.show(toolEditPermission('req-a'));
    expect(sendShow).not.toHaveBeenCalled();

    // Each webview reload clears delivery tracking and redisplays the one
    // pending prompt exactly once.
    canSend = true;
    toolEdit.replay();
    expect(sendShow).toHaveBeenCalledTimes(1);
    toolEdit.replay();
    expect(sendShow).toHaveBeenCalledTimes(2);

    toolEdit.dismiss('req-a');

    // A further reload must not resurrect an already-resolved approval.
    toolEdit.replay();
    expect(sendShow).toHaveBeenCalledTimes(2);
    expect(sendDismiss).toHaveBeenCalledWith('req-a');
  });

  it('replays a launch-path presentation event exactly once once the presentation host attaches', async () => {
    const session = createTestSession();
    testSessions.push(session);
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValue(undefined);

    try {
      // Emitted before any host has attached, mirroring a launch failure
      // (`AgentLaunchContext.ts`) firing before `ProgressViewProvider` is
      // constructed. Only the runtime's `replayWhenAttached` queue can save
      // this event.
      session.interactions.emit(
        'requestShowError',
        { message: 'Launch failed before the view attached.' },
        { replayWhenAttached: true },
      );
      expect(showErrorMessage).not.toHaveBeenCalled();

      const presentationHost = createAgentPresentationHost(
        {} as unknown as ProgressViewProvider,
      );
      const interactions = createExtensionHostInteractions({
        interactions: presentationHost,
        session,
        getApprovalHandlers: () => createRecordingApprovalHandlers(),
        getToolEditApprovals: () =>
          ({
            approvePendingForStream: vi.fn(async () => undefined),
            cancel: vi.fn(),
            requestApproval: vi.fn(),
          }) as unknown as ReturnType<
            ProgressHostInteractionsOptions['getToolEditApprovals']
          >,
        setApprovalBypassState: vi.fn(),
      });
      const detach = session.useHostInteractions(interactions);
      try {
        // The replay runs on a microtask queued by `use()`.
        await Promise.resolve();
        expect(showErrorMessage).toHaveBeenCalledTimes(1);
        expect(showErrorMessage).toHaveBeenCalledWith(
          'Launch failed before the view attached.',
        );
      } finally {
        detach();
      }
    } finally {
      showErrorMessage.mockRestore();
    }
  });
});
