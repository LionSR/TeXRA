import '@test/support/defaultSessionTestSetup';

import { Deferred, Effect, Fiber } from 'effect';
import { it } from '@effect/vitest';
// Test composition imports

// Suites for src/tools/wolfram (WolframTool approval gating and the
// wolframscript invocation it builds).

import { afterEach, describe, expect, vi } from 'vitest';
import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import type { RequestDecision, RunId } from '@shared/schemas';
import {
  APPROVE_SESSION_ACTION,
  approvalDecisionArms,
} from '@shared/session/approvalDecision';
import { closeSessionOf } from '@test/support/sessionEnd';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { WolframTool } from '@tools/wolfram/WolframTool';
import * as toolUtils from '@utils/system/toolUtils';
import {
  autoDecideRequests,
  createRecordingHost,
  decideRequest,
  sessionWithInteractions,
} from '../agent/progressTestUtils';

/**
 * Dispatch the tool the way the run loop does - through `guardedToolCall`, so
 * the guard the tool declares runs before its body - and hold the command
 * request that guard opens: the request is a `request.opened` row the run
 * parks on, answered by the case's own `request.decide`.
 */
function dispatchWolfram(
  runId: RunId,
  code: string,
  options: { readonly bashBypassed?: boolean } = {},
) {
  return Effect.gen(function* () {
    const session = yield* Effect.acquireRelease(
      Effect.sync(() =>
        sessionWithInteractions(createRecordingHost().interactions),
      ),
      (session) => closeSessionOf(session),
    );
    publishTestRunStart(session, runId);
    yield* session.settlePublications();
    if (options.bashBypassed) {
      session.approvals.bash.bypass.setBypass(runId, true, { silent: true });
    }
    const requestOpened = yield* Deferred.make<void>();
    const requests = yield* Effect.acquireRelease(
      Effect.sync(() =>
        autoDecideRequests(session, () => {
          Deferred.doneUnsafe(requestOpened, Effect.void);
          return null;
        }),
      ),
      (requests) => Effect.sync(() => requests.detach()),
    );

    const result = yield* Effect.forkChild(
      guardedToolCall(WolframTool, { code }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { session: session, runId: runId, toolPolicy: {} },
          }),
        ),
      ),
    );
    // A call that ran without asking settles the fiber instead.
    yield* Effect.raceFirst(Deferred.await(requestOpened), Fiber.await(result));
    const opened = requests.opened[0];
    if (!opened) throw new Error('The call ran without opening a request.');
    if (opened.payload.kind !== 'bash') {
      throw new Error(`Expected a bash request, not ${opened.payload.kind}.`);
    }
    return {
      result: Fiber.join(result),
      permission: opened.payload.data,
      decide: (decision: RequestDecision) =>
        decideRequest(
          session,
          { runId, requestId: opened.requestId },
          decision,
        ),
    };
  });
}

// it.live: the `request.opened` row these cases wait on is delivered by the
// Stream consumer `autoDecideRequests` forks on the process runtime, and the
// mocked `runToolWithCheck` resolves on the promise queue; nothing on the
// approval path sleeps through the Effect clock.
describe('WolframTool approval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.live('requests bash-style approval before executing wolframscript', () =>
    Effect.gen(function* () {
      const runId = 'a99f00000001' as RunId;
      const execute = vi.spyOn(toolUtils, 'runToolWithCheck').mockReturnValue(
        Effect.succeed({
          success: true,
          stdout: '2',
          stderr: '',
          timedOut: false,
          exitCode: 0,
        }),
      );

      const { result, permission, decide } = yield* dispatchWolfram(
        runId,
        '1+1',
      );
      expect(permission).toMatchObject({
        // The exact command the user is asked to approve, not a call back
        // into the same formatter the tool uses to build it.
        command: 'wolframscript -code "1+1"',
        // A per-call prompt: approving it for the session would have been
        // the run's shell grant.
        allowBypass: false,
        runId,
      });

      decide({ action: 'approve' });

      expect(yield* result).toMatchObject({
        output: '2',
        summary: 'Executed: 1+1',
      });
      expect(execute).toHaveBeenCalledWith(
        'wolframscript',
        ['-code', '1+1'],
        expect.objectContaining({ timeout: 30000 }),
      );
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  // Failure modes: the run's command grant lets the call through unasked, the
  // prompt offers a session grant (which a surface turns into the run's
  // command bypass), or the shared decision mapping still derives that
  // bypass from it.
  it.live('is not approved by a command grant and cannot mint one', () =>
    Effect.gen(function* () {
      const execute = vi.spyOn(toolUtils, 'runToolWithCheck');
      const { result, permission, decide } = yield* dispatchWolfram(
        'a99f00000003' as RunId,
        '2+2',
        { bashBypassed: true },
      );
      expect(permission.allowBypass).toBe(false);
      expect(() =>
        approvalDecisionArms(
          { kind: 'bash', data: permission },
          { action: APPROVE_SESSION_ACTION },
        ),
      ).toThrow();

      decide({ action: 'reject' });
      expect((yield* result).status).toBe('error');
      expect(execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live.each([
    {
      name: 'does not execute wolframscript when approval is rejected',
      feedback: 'Use the requested node check instead.',
      expectedInstruction: 'Use the requested node check instead.',
      expectedGuidance: false,
    },
    {
      name: 'tells the model not to retry after rejection without feedback',
      feedback: undefined,
      expectedInstruction: undefined,
      expectedGuidance: true,
    },
  ])('$name', ({ feedback, expectedInstruction, expectedGuidance }) =>
    Effect.gen(function* () {
      const execute = vi.spyOn(toolUtils, 'runToolWithCheck');

      const { result, decide } = yield* dispatchWolfram(
        'a99f00000002' as RunId,
        'Factor[n^7 - n]',
      );
      decide({
        action: 'reject',
        ...(feedback === undefined ? {} : { feedback }),
      });

      const rejection = yield* result;
      expect(rejection.status).toBe('error');
      if (rejection.status !== 'error') throw new Error('Expected rejection');
      expect(rejection.userInstruction).toBe(expectedInstruction);
      expect(rejection.error.includes('Do not retry')).toBe(expectedGuidance);
      expect(execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );
});
