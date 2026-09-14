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
 * A host whose staging and whose view opening can each be held open, so a
 * test can act on a request while it is still initializing, and again while
 * the host is presenting the request it staged.
 */
function createTestHost() {
  const staging = pDefer<void>();
  const presentation = pDefer<void>();
  const preview = {
    originalPath: '/tmp/original.tex',
    proposedPath: '/tmp/proposed.tex',
    present: vi.fn(async () => {
      await presentation.promise;
    }),
    showDiff: vi.fn(async () => {}),
    openProposed: vi.fn(async () => {}),
    readProposedContent: vi.fn(async () => 'edited by the user'),
    dispose: vi.fn(async () => {}),
  } satisfies ToolEditPreview;
  let context: ToolEditPreviewContext | undefined;
  return {
    staging,
    presentation,
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

  it('holds a release open until the staging in flight has disposed', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const presented = controller.present(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    const requestId = testHost.contextForRequest().requestId;

    // The `request.opened` commit was refused while the host was still
    // staging, so the release runs with a preview in flight: it may not
    // return before that preview is disposed, or the caller it answers
    // would report the refusal with temp files still being written.
    let released = false;
    const release = controller.release(requestId).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    expect(testHost.preview.dispose).not.toHaveBeenCalled();

    testHost.staging.resolve();
    await release;
    expect(released).toBe(true);
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();

    await presented;
    expect(testHost.preview.present).not.toHaveBeenCalled();
  });

  it('holds a release open until the view being opened has disposed', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const presented = controller.present(approvalRequest());
    await vi.waitFor(() => testHost.contextForRequest());
    const requestId = testHost.contextForRequest().requestId;

    // Staging finished, so the request is staged and the host is opening its
    // view on the staged files. A release now may not return before that view
    // is open and closed again: closing it is what the release is for.
    testHost.staging.resolve();
    await vi.waitFor(() => {
      expect(testHost.preview.present).toHaveBeenCalledOnce();
    });

    let released = false;
    const release = controller.release(requestId).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    expect(testHost.preview.dispose).not.toHaveBeenCalled();

    testHost.presentation.resolve();
    await release;
    expect(released).toBe(true);
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();

    // Nothing opens a view after the release resolved.
    await presented;
    expect(testHost.preview.present).toHaveBeenCalledOnce();
    expect(testHost.preview.showDiff).not.toHaveBeenCalled();
  });

  it('joins a second release to the cleanup the first one is running', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);
    const disposal = pDefer<void>();
    testHost.preview.dispose.mockImplementation(() => disposal.promise);

    testHost.staging.resolve();
    testHost.presentation.resolve();
    await controller.present(approvalRequest());
    const requestId = testHost.contextForRequest().requestId;

    // `dispose` starts a release for every staged request without awaiting
    // it, and the host's release for a refused `request.opened` lands right
    // behind it: the second one finds the entry already dropped, so it has
    // only the cleanup in flight to wait for.
    controller.dispose();
    let released = false;
    const release = controller.release(requestId).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);

    disposal.resolve();
    await release;
    expect(released).toBe(true);
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();
  });

  it('ignores actions that arrive after the request was decided', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    testHost.staging.resolve();
    testHost.presentation.resolve();
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
