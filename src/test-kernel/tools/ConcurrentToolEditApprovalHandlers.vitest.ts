// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession as createIsolatedTestSession } from '@test/support/sessionTestUtils';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

/**
 * Proves the desktop multi-window invariant: two runs owned by distinct
 * sessions never cross-talk, even when both requests are in flight at once.
 * Each request must resolve through the `SessionHandle.interactions` owner
 * captured by its run context.
 */
describe('Concurrent session tool edit approval handlers', () => {
  setupPlatform({ workspacePath: '/workspace', config: {}, files: {} });

  const testSessions: SessionHandle[] = [];

  function createTestSession(): SessionHandle {
    const session = createIsolatedTestSession();
    testSessions.push(session);
    return session;
  }

  beforeEach(() => {
    defaultSession().approvals.clearAll();
    defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
  });

  afterEach(() => {
    defaultSession().approvals.clearAll();
    defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
    for (const session of testSessions.splice(0)) session.dispose();
  });

  it('routes each in-flight request through its owning session', async () => {
    function recordingHandler(
      seen: ToolEditApprovalRequest[],
      appliedContent: string,
    ) {
      return async (
        request: ToolEditApprovalRequest,
      ): Promise<ToolEditApprovalResult> => {
        seen.push(request);
        return { action: 'apply', appliedContent };
      };
    }

    function makeRequest(tag: string): ToolEditApprovalRequest {
      return {
        path: `${tag}.tex`,
        originalContent: `old-${tag}`,
        proposedContent: `new-${tag}`,
        sourceTool: 'write_file',
      };
    }

    const seenByA: ToolEditApprovalRequest[] = [];
    const seenByB: ToolEditApprovalRequest[] = [];

    const sessionA = createTestSession();
    const sessionB = createTestSession();
    sessionA.useHostInteractions({
      requestToolEditApproval: recordingHandler(seenByA, 'from-a'),
      cancel: () => undefined,
    });
    sessionB.useHostInteractions({
      requestToolEditApproval: recordingHandler(seenByB, 'from-b'),
      cancel: () => undefined,
    });

    const contextA = createRunContext({
      streamId: 'windowA@model: test.tex' as StreamTabId,
      session: sessionA,
    });
    const contextB = createRunContext({
      streamId: 'windowB@model: test.tex' as StreamTabId,
      session: sessionB,
    });

    // Fire both without awaiting between them — each call must still
    // resolve through the handler captured from its own RunContext, not
    // whichever ran last.
    const resultAPromise = withRunContext(contextA, () =>
      requestToolEditApproval(makeRequest('a')),
    );
    const resultBPromise = withRunContext(contextB, () =>
      requestToolEditApproval(makeRequest('b')),
    );

    const [resultA, resultB] = await Promise.all([
      resultAPromise,
      resultBPromise,
    ]);

    expect(seenByA.map((request) => request.path)).toEqual(['a.tex']);
    expect(seenByB.map((request) => request.path)).toEqual(['b.tex']);

    expect(resultA).toMatchObject({
      action: 'apply',
      appliedContent: 'from-a',
    });
    expect(resultB).toMatchObject({
      action: 'apply',
      appliedContent: 'from-b',
    });
  });
});
