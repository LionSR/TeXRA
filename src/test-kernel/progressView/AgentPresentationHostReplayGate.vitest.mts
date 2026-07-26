// Test support imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  HostBashApprovalResult,
  HostUserQuestionResult,
  PlanApprovalResult,
  ProposalResult,
  RetryResult,
} from '@agent/runtime/HostInteractions';
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import {
  ProgressInteractionHandler,
  type UICallbacks,
} from '@controllers/progressView/backend/events/ProgressInteractionHandler';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';
import { createAgentPresentationHost } from '@frontend/events/agentEventListeners';
import { setExtensionInteractionEventSink } from '@frontend/events/extensionInteractionEvents';
import { createExtensionHostInteractions } from '@progressView/extensionHostInteractions';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

/**
 * #9251 behavioral gate: the extension's `HostInteractions.emit` now routes
 * presentation and progress-view interaction events the way desktop's does
 * (a thin pass-through to a caller-supplied `AgentRuntimeHost`), replacing a
 * deleted per-host presentation-event bus and its 1000-event replay buffer.
 * These tests pin the two things that buffer used to guarantee and that must
 * still hold true with it gone:
 *
 *  1. A pending tool-edit approval redisplays exactly once per webview
 *     reload, and never redisplays once resolved — owned entirely by
 *     `ApprovalRequestHandler`'s pending/delivered bookkeeping, untouched by
 *     this refactor.
 *  2. A presentation event emitted before any host attaches (the launch
 *     path, before `ProgressViewProvider` is constructed) is not lost: the
 *     runtime's `replayWhenAttached` queue — not the deleted buffer —
 *     replays it exactly once when the presentation host attaches.
 */

const mocks = vi.hoisted(() => ({
  nativeRequestApproval: vi.fn(),
  cancelNativeToolEditApprovals: vi.fn(),
  approveNativeToolEditApprovals: vi.fn(async () => undefined),
  getLinterMessages: vi.fn(async () => []),
  pushManualCriticism: vi.fn(() => true),
}));

vi.mock('@frontend/approval/nativeToolEditApproval', () => ({
  nativeRequestApproval: mocks.nativeRequestApproval,
  cancelNativeToolEditApprovals: mocks.cancelNativeToolEditApprovals,
  approveNativeToolEditApprovals: mocks.approveNativeToolEditApprovals,
}));

vi.mock('@frontend/latex/linter', () => ({
  getLinterMessages: mocks.getLinterMessages,
}));

vi.mock('@frontend/latex/inlineCriticism', () => ({
  pushManualCriticism: mocks.pushManualCriticism,
}));

function noopHandler<
  T extends { streamId: string },
  K extends keyof T,
  Result = never,
>(idField: K): ApprovalRequestHandler<T, K, Result> {
  return new ApprovalRequestHandler<T, K, Result>(
    idField,
    () => {},
    () => {},
    () => true,
  );
}

/**
 * A full seven-kind handler set with harmless no-op transports for the six
 * kinds these tests don't exercise. `HostInteractions.cancel()` (run on
 * session disposal, via `afterEach`) reaches every kind unconditionally, so
 * each must be a real `ApprovalRequestHandler`. `toolEdit` defaults to a
 * fresh handler; pass the one under test to keep disposal cancelling the
 * same instance a test observed.
 */
function createApprovalHandlers(
  toolEdit: ApprovalRequestHandlerSet['toolEdit'] = noopHandler<
    ToolEditPermission,
    'requestId'
  >('requestId'),
): ApprovalRequestHandlerSet {
  return {
    toolEdit,
    bash: noopHandler<BashPermission, 'requestId', HostBashApprovalResult>(
      'requestId',
    ),
    retry: noopHandler<RetryPermission, 'streamId', RetryResult>('streamId'),
    agentProposal: noopHandler<
      AgentProposalPermission,
      'proposalId',
      ProposalResult
    >('proposalId'),
    planApproval: noopHandler<
      PlanApprovalPermission,
      'approvalId',
      PlanApprovalResult
    >('approvalId'),
    externalInquiry: noopHandler<ExternalInquiryPermission, 'requestId'>(
      'requestId',
    ),
    userQuestion: noopHandler<
      UserQuestionPermission,
      'requestId',
      HostUserQuestionResult
    >('requestId'),
  };
}

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

function attachedSession(): SessionHandle {
  const session = createTestSession();
  testSessions.push(session);
  return session;
}

describe('extension presentation-event emit port (#9251 replay gate)', () => {
  it('redisplays a pending tool-edit approval exactly once per webview reload', () => {
    const session = attachedSession();
    let canSend = false;
    const sendShow = vi.fn();
    const sendDismiss = vi.fn();
    const toolEdit = new ApprovalRequestHandler<
      ToolEditPermission,
      'requestId'
    >('requestId', sendShow, sendDismiss, () => canSend);
    const uiCallbacks: UICallbacks = {
      showToolEditPermission: (p) => toolEdit.show(p),
      resolveToolEditPermission: (id) => toolEdit.dismiss(id),
    };
    const interactionHandler = new ProgressInteractionHandler(uiCallbacks);
    const detachSink = setExtensionInteractionEventSink((event, payload) =>
      interactionHandler.handleInteractionEvent(event, payload),
    );
    const presentationHost = createAgentPresentationHost(
      {} as unknown as ProgressViewProvider,
    );
    const interactions = createExtensionHostInteractions({
      runtimeHost: presentationHost,
      session,
      getApprovalHandlers: () => createApprovalHandlers(toolEdit),
      setApprovalBypassState: vi.fn(),
    });
    const detachInteractions = session.useHostInteractions(interactions);

    try {
      // The webview isn't ready yet (mirrors `nativeToolEditApproval.ts`
      // calling `getRuntimeHost().emit('showToolEditPermission', ...)`):
      // the request is tracked but not delivered.
      session.interactions.emit(
        'showToolEditPermission',
        toolEditPermission('req-a'),
      );
      expect(sendShow).not.toHaveBeenCalled();

      // Webview reload #1 (`ProgressViewProvider.markWebviewReady` →
      // `replayPendingPrompts` → `replayApprovalRequestHandlers`): the
      // webview becomes ready and replay delivers the pending prompt once.
      canSend = true;
      toolEdit.replay();
      expect(sendShow).toHaveBeenCalledTimes(1);

      // Reload #2: still exactly one further redisplay per reload — not a
      // duplicate flood, and not a dropped prompt.
      toolEdit.replay();
      expect(sendShow).toHaveBeenCalledTimes(2);

      // The approval resolves (mirrors the `resolveToolEditPermission`
      // event fired once the user acts on it in the native diff view).
      session.interactions.emit('resolveToolEditPermission', {
        requestId: 'req-a',
      });

      // A further reload must not resurrect an already-resolved approval.
      toolEdit.replay();
      expect(sendShow).toHaveBeenCalledTimes(2);
      expect(sendDismiss).toHaveBeenCalledWith('req-a');
    } finally {
      detachInteractions();
      detachSink();
    }
  });

  it('replays a launch-path presentation event exactly once once the presentation host attaches', async () => {
    const session = attachedSession();
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValue(undefined);

    try {
      // Emitted before any host has attached — mirrors a launch failure
      // (`AgentLaunchContext.ts`) firing before `ProgressViewProvider` is
      // constructed. Only the runtime's `replayWhenAttached` queue — not the
      // deleted buffer — can save this event.
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
        runtimeHost: presentationHost,
        session,
        getApprovalHandlers: () => createApprovalHandlers(),
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
