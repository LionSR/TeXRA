// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import * as assert from 'node:assert';
import { createTestSession as createIsolatedTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { describe, it, beforeEach, afterEach } from 'vitest';

// Local imports - tests
import { setupPlatform } from '@test/support/setupPlatform';

// Local imports - agent types
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - tools
import type { StreamTabId } from '@shared/schemas';
import { cleanupAllApprovals } from '@tools/approval';
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
    cleanupAllApprovals();
  });

  afterEach(() => {
    cleanupAllApprovals();
    for (const session of testSessions.splice(0)) session.dispose();
  });

  it('routes each in-flight request through its owning session', async () => {
    const seenByA: ToolEditApprovalRequest[] = [];
    const seenByB: ToolEditApprovalRequest[] = [];

    const handlerA = async (
      request: ToolEditApprovalRequest,
    ): Promise<ToolEditApprovalResult> => {
      seenByA.push(request);
      return { accepted: true, appliedContent: 'from-a' };
    };
    const handlerB = async (
      request: ToolEditApprovalRequest,
    ): Promise<ToolEditApprovalResult> => {
      seenByB.push(request);
      return { accepted: true, appliedContent: 'from-b' };
    };

    const sessionA = createTestSession();
    const sessionB = createTestSession();
    sessionA.useHostInteractions({
      requestToolEditApproval: handlerA,
      resolve: () => false,
      cancel: () => undefined,
    });
    sessionB.useHostInteractions({
      requestToolEditApproval: handlerB,
      resolve: () => false,
      cancel: () => undefined,
    });

    const contextA = createRunContext({
      runtimeHost: noopAgentRuntimeHost,
      streamId: 'windowA@model: test.tex' as StreamTabId,
      session: sessionA,
    });
    const contextB = createRunContext({
      runtimeHost: noopAgentRuntimeHost,
      streamId: 'windowB@model: test.tex' as StreamTabId,
      session: sessionB,
    });

    const requestA: ToolEditApprovalRequest = {
      path: 'a.tex',
      originalContent: 'old-a',
      proposedContent: 'new-a',
      sourceTool: 'write_file',
    };
    const requestB: ToolEditApprovalRequest = {
      path: 'b.tex',
      originalContent: 'old-b',
      proposedContent: 'new-b',
      sourceTool: 'write_file',
    };

    // Fire both without awaiting between them — each call must still
    // resolve through the handler captured from its own RunContext, not
    // whichever ran last.
    const resultAPromise = withRunContext(contextA, () =>
      requestToolEditApproval(requestA),
    );
    const resultBPromise = withRunContext(contextB, () =>
      requestToolEditApproval(requestB),
    );

    const [resultA, resultB] = await Promise.all([
      resultAPromise,
      resultBPromise,
    ]);

    assert.strictEqual(seenByA.length, 1);
    assert.strictEqual(seenByA[0]?.path, 'a.tex');
    assert.strictEqual(seenByB.length, 1);
    assert.strictEqual(seenByB[0]?.path, 'b.tex');

    assert.strictEqual(resultA.appliedContent, 'from-a');
    assert.strictEqual(resultB.appliedContent, 'from-b');
  });
});
