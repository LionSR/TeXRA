// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Effect, Fiber, Stream } from 'effect';
import pDefer from 'p-defer';
import { describe, expect, it } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { BashPermission } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { requestBashApproval } from '@tools/approval/bashApproval';
import { generateRunId } from '@utils/core';

/**
 * Watch the bash requests a run opens the way a surface does: off the
 * session's `request.opened` rows, which is the whole of a pending request
 * now that no host port holds a queue.
 */
function watchBashRequests(session: SessionHandle) {
  const opened: BashPermission[] = [];
  const firstOpened = pDefer<void>();
  const decisions: Array<() => void> = [];
  const fiber = Effect.runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => {
        if (event.type !== 'request.opened') return;
        if (event.payload.kind !== 'bash') return;
        opened.push(event.payload.data);
        decisions.push(() =>
          session.publish([
            {
              type: 'request.decided',
              aggregateId: event.aggregateId,
              requestId: event.requestId,
              decision: { action: 'approve' },
            },
          ]),
        );
        firstOpened.resolve();
      }),
    ),
  );
  return {
    opened,
    firstOpened: firstOpened.promise,
    /** Answer the request opened at `index` with a plain approval. */
    approve: (index: number) => decisions[index]?.(),
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
}

describe('requestBashApproval queueing', () => {
  it('lets never override a run bypass at the shared boundary', async () => {
    const session = createTestSession();
    const runId = generateRunId();
    let policyDenials = 0;
    session.setApprovalPolicy('never');
    session.approvals.bash.bypass.setBypass(runId, true, { silent: true });
    const requests = watchBashRequests(session);

    try {
      const result = await withRunContext(
        createRunContext({
          runId,
          session,
          onApprovalPolicyDenial: () => {
            policyDenials += 1;
          },
        }),
        () =>
          Effect.runPromise(requestBashApproval({ command: 'echo denied' })),
      );

      expect(result).toEqual({
        action: 'deny',
        reason: 'Denied by TeXRA approval policy.',
      });
      expect(policyDenials).toBe(1);
      expect(requests.opened).toEqual([]);
    } finally {
      await requests.stop();
      session.dispose();
    }
  });

  it('auto-approves a queued request once the run is bypassed while it waits', async () => {
    const session = createTestSession();
    const runId = generateRunId();
    // A request is a row on its run, so the run must exist first.
    publishTestRunStart(session, runId);
    await session.settlePublications();
    const requests = watchBashRequests(session);

    const request = (command: string) =>
      withRunContext(createRunContext({ runId, session }), () =>
        Effect.runPromise(requestBashApproval({ command })),
      );

    try {
      const first = request('echo first');
      const second = request('echo second');
      await requests.firstOpened;
      expect(requests.opened.map((permission) => permission.command)).toEqual([
        'echo first',
      ]);

      // The user answers the first request with "approve and stop asking";
      // the second must honor that instead of opening a request of its own.
      session.approvals.bash.bypass.setBypass(runId, true, { silent: true });
      requests.approve(0);

      expect(await first).toEqual({ action: 'approve' });
      expect(await second).toEqual({ action: 'approve' });
      expect(requests.opened).toHaveLength(1);
    } finally {
      await requests.stop();
      session.dispose();
    }
  });
});
