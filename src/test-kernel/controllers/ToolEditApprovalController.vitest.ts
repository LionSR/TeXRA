// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import pDefer from 'p-defer';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  ToolEditApprovalController,
  type ToolEditPreview,
  type ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import type { StreamTabId, ToolEditPermission } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

const STREAM_ID = 'TestAgent@model: paper.tex' as StreamTabId;

function approvalRequest(): ToolEditApprovalRequest {
  return {
    path: '/workspace/paper.tex',
    originalContent: 'old',
    proposedContent: 'new',
    sourceTool: 'edit_file',
    streamId: STREAM_ID,
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
      relativeDisplayPath: (filePath: string) => filePath,
      revealApprovalSurface: async () => {},
      openBuildDisplay: async () => {},
      reportError: vi.fn(),
    },
  };
}

function createController(host: ReturnType<typeof createTestHost>['host']) {
  const session = createTestSession();
  const prompts: ToolEditPermission[] = [];
  const resolved: string[] = [];
  const controller = new ToolEditApprovalController({
    interactions: { emit: () => {} },
    session,
    host,
    showToolEditPermission: (payload) => prompts.push(payload),
    resolveToolEditPermission: (requestId) => resolved.push(requestId),
    detachCause: 'Test session detached.',
  });
  return { controller, prompts, resolved, session };
}

describe('tool edit approval controller', () => {
  it('settles a request cancelled while its preview is still staging', async () => {
    const testHost = createTestHost();
    const { controller, prompts, session } = createController(testHost.host);

    const approval = controller.requestApproval(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    controller.cancel({ cause: 'Stream resources released.' });
    expect(testHost.contextForRequest().isSettled()).toBe(true);
    testHost.staging.resolve();

    await expect(approval).resolves.toEqual({
      accepted: false,
      userMessage: 'Stream resources released.',
    });
    // No prompt is ever published for a request that never reached the user,
    // and the staged copies are cleaned up on the way out.
    expect(prompts).toEqual([]);
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();
    expect(testHost.preview.present).not.toHaveBeenCalled();
    session.dispose();
  });

  it('approves a still-staging request from its stream without reading the staged file', async () => {
    const testHost = createTestHost();
    const { controller, prompts, session } = createController(testHost.host);

    const approval = controller.requestApproval(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    await controller.approvePendingForStream(STREAM_ID);
    testHost.staging.resolve();

    await expect(approval).resolves.toEqual({
      accepted: true,
      appliedContent: 'new',
    });
    expect(testHost.preview.readProposedContent).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
    session.dispose();
  });

  it('ignores actions that arrive after the request settled', async () => {
    const testHost = createTestHost();
    const { controller, resolved, session } = createController(testHost.host);

    const approval = controller.requestApproval(approvalRequest());
    testHost.staging.resolve();
    const requestId = await vi.waitFor(() => {
      const id = testHost.contextForRequest().requestId;
      expect(testHost.preview.present).toHaveBeenCalled();
      return id;
    });

    controller.handleAction({ requestId, action: 'approve' });
    await expect(approval).resolves.toEqual({
      accepted: true,
      appliedContent: 'edited by the user',
    });

    controller.handleAction({ requestId, action: 'openDiff' });
    controller.handleAction({ requestId, action: 'reject' });
    await Promise.resolve();

    // The settled request is gone from the controller, so late actions neither
    // reopen its view nor resolve its prompt a second time.
    expect(testHost.preview.showDiff).not.toHaveBeenCalled();
    expect(resolved).toEqual([requestId]);
    expect(testHost.contextForRequest().isSettled()).toBe(true);
    session.dispose();
  });
});
