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
import type { StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { toolEditApprovalRequest } from '../agent/progressTestUtils';

const STREAM_ID = 'TestAgent@model: paper.tex' as StreamTabId;

function approvalRequest(): ToolEditApprovalRequest {
  return toolEditApprovalRequest({
    path: '/workspace/paper.tex',
    originalContent: 'old',
    proposedContent: 'new',
    sourceTool: 'edit_file',
    streamId: STREAM_ID,
  });
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
    },
  };
}

function createController(host: ReturnType<typeof createTestHost>['host']) {
  const session = createTestSession();
  const controller = new ToolEditApprovalController({ host, session });
  onTestFinished(() => {
    controller.dispose();
    session.dispose();
  });
  return controller;
}

describe('tool edit approval controller', () => {
  it('settles a request cancelled while its preview is still staging', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const approval = controller.requestApproval(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    controller.cancel({ cause: 'Stream resources released.' });
    expect(testHost.contextForRequest().isSettled()).toBe(true);
    testHost.staging.resolve();

    await expect(approval).resolves.toEqual({
      action: 'reject',
      cause: 'Stream resources released.',
    });
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();
    expect(testHost.preview.present).not.toHaveBeenCalled();
  });

  it('approves a still-staging request from its stream without reading the staged file', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const approval = controller.requestApproval(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    await controller.approvePendingForStream(STREAM_ID);
    testHost.staging.resolve();

    await expect(approval).resolves.toEqual({
      action: 'apply',
      appliedContent: 'new',
    });
    expect(testHost.preview.readProposedContent).not.toHaveBeenCalled();
  });

  it('ignores actions that arrive after the request settled', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const approval = controller.requestApproval(approvalRequest());
    testHost.staging.resolve();
    const requestId = await vi.waitFor(() => {
      const id = testHost.contextForRequest().requestId;
      expect(testHost.preview.present).toHaveBeenCalled();
      return id;
    });

    controller.handleAction({ requestId, action: 'approve' });
    await expect(approval).resolves.toEqual({
      action: 'apply',
      appliedContent: 'edited by the user',
    });

    controller.handleAction({ requestId, action: 'openDiff' });
    controller.handleAction({ requestId, action: 'reject' });
    await Promise.resolve();

    // A settled request cannot reopen its preview.
    expect(testHost.preview.showDiff).not.toHaveBeenCalled();
    expect(testHost.contextForRequest().isSettled()).toBe(true);
  });
});
