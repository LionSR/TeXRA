// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import pDefer from 'p-defer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

// Local imports
import {
  ToolEditApprovalController,
  type ToolEditPreview,
  type ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import {
  aggregateId as qualifyAggregateId,
  RunIdSchema,
  type SessionEvent,
} from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { toolEditApprovalRequest } from '../agent/progressTestUtils';

const RUN = RunIdSchema.parse('ab12cd');

function approvalRequest(): ToolEditApprovalRequest {
  return toolEditApprovalRequest({
    path: '/workspace/paper.tex',
    originalContent: 'old',
    proposedContent: 'new',
    sourceTool: 'edit_file',
    runId: RUN,
  });
}

/** The fold's answer to a request, as the plane hands it to the controller. */
function decided(requestId: string): SessionEvent {
  return {
    type: 'request.decided',
    aggregateId: qualifyAggregateId('run', RUN),
    requestId,
    decision: { action: 'approve' },
    seq: 1,
    commit: 1,
    ownerId: null,
    at: 0,
  };
}

/**
 * A host whose staging can be held open, so a test can act on a request while
 * it is still initializing.
 */
function createTestHost() {
  const staging = pDefer<void>();
  const preview = {
    originalPath: '/tmp/original.tex',
    proposedPath: '/tmp/proposed.tex',
    present: vi.fn(async () => {}),
    showDiff: vi.fn(async () => {}),
    openProposed: vi.fn(async () => {}),
    readProposedContent: vi.fn(async () => 'edited by the user'),
    dispose: vi.fn(async () => {}),
  } satisfies ToolEditPreview;
  let context: ToolEditPreviewContext | undefined;
  return {
    staging,
    preview,
    contextForRequest: (): ToolEditPreviewContext => {
      if (!context) throw new Error('stagePreview has not been called yet.');
      return context;
    },
    host: {
      stagePreview: async (
        _request: ToolEditApprovalRequest,
        previewContext: ToolEditPreviewContext,
      ) => {
        context = previewContext;
        await staging.promise;
        return preview;
      },
      revealApprovalSurface: async () => {},
      openBuildDisplay: async () => {},
      reportError: vi.fn(),
      decide: vi.fn(async () => {}),
    },
  };
}

function createController(host: ReturnType<typeof createTestHost>['host']) {
  const controller = new ToolEditApprovalController({ host });
  onTestFinished(() => {
    controller.dispose();
  });
  return controller;
}

describe('tool edit approval controller', () => {
  it('decides a request discarded while its preview is still staging', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const presented = controller.present(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    const requestId = testHost.contextForRequest().requestId;
    testHost.contextForRequest().discard();
    expect(testHost.contextForRequest().isSettled()).toBe(true);
    testHost.staging.resolve();
    await presented;

    expect(testHost.host.decide).toHaveBeenCalledWith(RUN, requestId, {
      action: 'reject',
    });
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();
    expect(testHost.preview.present).not.toHaveBeenCalled();
  });

  it('approves a still-staging request from its run without reading the staged file', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const presented = controller.present(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    const requestId = testHost.contextForRequest().requestId;
    await controller.approvePendingForRun(RUN);
    testHost.staging.resolve();
    await presented;

    expect(testHost.host.decide).toHaveBeenCalledWith(RUN, requestId, {
      action: 'approve',
      content: 'new',
    });
    expect(testHost.preview.readProposedContent).not.toHaveBeenCalled();
  });

  it('ignores actions that arrive after the request was decided', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    testHost.staging.resolve();
    await controller.present(approvalRequest());
    const requestId = testHost.contextForRequest().requestId;
    expect(testHost.preview.present).toHaveBeenCalled();

    controller.handleAction({ requestId, action: 'approve' });
    await vi.waitFor(() => {
      expect(testHost.host.decide).toHaveBeenCalledWith(RUN, requestId, {
        action: 'approve',
        content: 'edited by the user',
      });
    });

    // The fold's answer releases the preview; nothing acts on it afterwards.
    controller.handleSessionEvent(decided(requestId));
    await vi.waitFor(() => {
      expect(testHost.preview.dispose).toHaveBeenCalledOnce();
    });

    controller.handleAction({ requestId, action: 'openDiff' });
    controller.handleAction({ requestId, action: 'reject' });
    await Promise.resolve();

    expect(testHost.preview.showDiff).not.toHaveBeenCalled();
    expect(testHost.host.decide).toHaveBeenCalledOnce();
  });
});
