// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Effect, Fiber, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTestSession as createIsolatedTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';

type PendingToolEdit = Omit<ToolEditApprovalRequest, 'permission'>;

/**
 * Proves the desktop multi-window invariant: two runs owned by distinct
 * sessions never cross-talk, even when both requests are in flight at once.
 * Each request must resolve through the `request.decided` row of the session
 * its run context captured, and be staged on that session's host.
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
  });

  afterEach(() => {
    defaultSession().approvals.clearAll();
    for (const session of testSessions.splice(0)) session.dispose();
  });

  it('routes each in-flight request through its owning session', async () => {
    /**
     * Stand in for one window: record the previews the session stages and
     * answer every request it opens with the content that window's user left
     * in its diff view.
     */
    function attachWindow(session: SessionHandle, appliedContent: string) {
      const seen: string[] = [];
      session.interactions.use({
        presentToolEdit: (staged) => seen.push(staged.permission.relativePath),
      });
      const fiber = Effect.runFork(
        Stream.runForEach(session.events.all(session.now()), (event) =>
          Effect.sync(() => {
            if (event.type !== 'request.opened') return;
            if (event.payload.kind !== 'toolEdit') return;
            session.publish([
              {
                type: 'request.decided',
                aggregateId: event.aggregateId,
                requestId: event.requestId,
                decision: { action: 'approve', content: appliedContent },
              },
            ]);
          }),
        ),
      );
      return { seen, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) };
    }

    function makeRequest(tag: string): PendingToolEdit {
      return {
        path: `/workspace/${tag}.tex`,
        originalContent: `old-${tag}`,
        proposedContent: `new-${tag}`,
        sourceTool: 'write_file',
      };
    }

    const sessionA = createTestSession();
    const sessionB = createTestSession();
    const windowA = attachWindow(sessionA, 'from-a');
    const windowB = attachWindow(sessionB, 'from-b');

    // A request is a row on its run, so each run must exist first.
    const runA = publishTestRunStart(sessionA);
    const runB = publishTestRunStart(sessionB);
    await Promise.all([
      sessionA.settlePublications(),
      sessionB.settlePublications(),
    ]);
    const contextA = createRunContext({ runId: runA, session: sessionA });
    const contextB = createRunContext({ runId: runB, session: sessionB });

    try {
      // Fire both without awaiting between them — each call must still
      // resolve through the session captured from its own RunContext, not
      // whichever ran last.
      const resultAPromise = withRunContext(contextA, () =>
        Effect.runPromise(requestToolEditApproval(makeRequest('a'))),
      );
      const resultBPromise = withRunContext(contextB, () =>
        Effect.runPromise(requestToolEditApproval(makeRequest('b'))),
      );

      const [resultA, resultB] = await Promise.all([
        resultAPromise,
        resultBPromise,
      ]);

      expect(windowA.seen).toEqual(['a.tex']);
      expect(windowB.seen).toEqual(['b.tex']);

      expect(resultA).toMatchObject({
        action: 'apply',
        appliedContent: 'from-a',
      });
      expect(resultB).toMatchObject({
        action: 'apply',
        appliedContent: 'from-b',
      });
    } finally {
      await windowA.stop();
      await windowB.stop();
    }
  });
});
