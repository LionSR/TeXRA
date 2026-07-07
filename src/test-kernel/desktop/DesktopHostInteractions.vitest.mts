import { describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@agent/runtime/hostProgressEvents';
import { createDesktopHostInteractions } from '@desktop/main/desktopHostInteractions';
import type { DesktopToolEditApprovalController } from '@desktop/main/desktopToolEditApproval';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@shared/progressView/backend/progressBackendUiConfig';

interface RecordingApprovalHandler {
  readonly show: ReturnType<typeof vi.fn>;
  readonly resolve: ReturnType<typeof vi.fn>;
  readonly replay: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly hasPendingForStream: ReturnType<typeof vi.fn>;
  readonly releaseForStream: ReturnType<typeof vi.fn>;
  readonly clear: ReturnType<typeof vi.fn>;
  readonly pendingSize: number;
}

function handler(): RecordingApprovalHandler {
  return {
    show: vi.fn(),
    resolve: vi.fn(),
    replay: vi.fn(),
    get: vi.fn(),
    hasPendingForStream: vi.fn(() => false),
    releaseForStream: vi.fn(),
    clear: vi.fn(),
    pendingSize: 0,
  };
}

function createHandlers(): ApprovalRequestHandlerSet {
  return {
    toolEdit: handler(),
    bash: handler(),
    retry: handler(),
    agentProposal: handler(),
    planApproval: handler(),
    externalInquiry: handler(),
    userQuestion: handler(),
  } as unknown as ApprovalRequestHandlerSet;
}

function createRuntimeHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    showErrorMessage: vi.fn(),
    emitStatus: vi.fn(),
    emitProgressEvent: vi.fn(),
  } as unknown as AgentRuntimeHost;
}

function createToolEditApprovals(): DesktopToolEditApprovalController {
  return {
    requestApproval: vi.fn(),
    handleAction: vi.fn(),
    dispose: vi.fn(),
  } as unknown as DesktopToolEditApprovalController;
}

describe('createDesktopHostInteractions', () => {
  it('keeps pending requests unresolved when the resolution kind is wrong', async () => {
    const handlers = createHandlers();
    const interactions = createDesktopHostInteractions({
      runtimeHost: createRuntimeHost(),
      getApprovalHandlers: () => handlers,
      getToolEditApprovals: () => createToolEditApprovals(),
    });

    const resultPromise = interactions.requestPlanApproval?.({
      approvalId: 'plan-desktop',
      streamId: 'stream-desktop' as StreamTabId,
      goalEnabled: false,
      plan: { objective: 'Align host interaction semantics.' },
    });

    expect(resultPromise).toBeDefined();
    expect(
      interactions.resolve('plan-desktop', {
        kind: 'bash',
        action: 'approve',
      }),
    ).toBe(false);
    expect(handlers.planApproval.resolve).not.toHaveBeenCalled();

    expect(
      interactions.resolve('plan-desktop', {
        kind: 'plan',
        action: 'approve',
      }),
    ).toBe(true);
    await expect(resultPromise).resolves.toEqual({ action: 'approve' });
    expect(handlers.planApproval.resolve).toHaveBeenCalledWith('plan-desktop');
  });

  it('uses the shared proposal mapper instead of passing unknown actions through', async () => {
    const handlers = createHandlers();
    const interactions = createDesktopHostInteractions({
      runtimeHost: createRuntimeHost(),
      getApprovalHandlers: () => handlers,
      getToolEditApprovals: () => createToolEditApprovals(),
    });

    const resultPromise = interactions.requestAgentProposal?.({
      proposalId: 'proposal-desktop',
      streamId: 'stream-desktop' as StreamTabId,
      agent: 'assistant',
      model: 'test-model',
      instruction: 'Use an agent.',
      memories: [],
      agentCategory: AgentCategory.ToolUse,
    });

    expect(
      interactions.resolve('proposal-desktop', {
        kind: 'proposal',
        action: 'reject',
        feedback: 'Not now.',
        value: { action: 'future-action' },
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      action: 'reject',
      feedback: 'Not now.',
    });
  });
});
