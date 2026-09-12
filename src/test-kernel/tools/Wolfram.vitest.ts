import '@test/support/defaultSessionTestSetup';

import { Effect, Fiber } from 'effect';
import { it } from '@effect/vitest';
// Test composition imports

// Suites for src/tools/wolfram (WolframTool approval gating and the
// wolframscript invocation it builds).

import { afterEach, describe, expect, vi } from 'vitest';
import type { RequestDecision, RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  wolframApprovalCommand,
  wolframRunSummary,
  WolframTool,
} from '@tools/wolfram/WolframTool';
import * as toolUtils from '@utils/system/toolUtils';
import {
  autoDecideRequests,
  createRecordingHost,
  decideRequest,
  sessionWithInteractions,
} from '../agent/progressTestUtils';
import { waitForCondition } from '../support/asyncTestUtils';

/** Sessions and request watchers the cases opened, released after each. */
const cleanups: Array<() => void> = [];

/**
 * Dispatch the tool on its own run and hold the command request it opens: the
 * request is a `request.opened` row the run parks on, answered by the case's
 * own `request.decide`.
 */
function dispatchWolfram(runId: RunId, code: string) {
  return Effect.gen(function* () {
    const session = sessionWithInteractions(createRecordingHost().interactions);
    publishTestRunStart(session, runId);
    yield* Effect.promise(() => session.settlePublications());
    const requests = autoDecideRequests(session, () => null);
    cleanups.push(() => {
      requests.detach();
      session.dispose();
    });

    const result = yield* Effect.forkChild(
      new WolframTool().call({ code }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { session: session, runId: runId, toolPolicy: {} },
          }),
        ),
      ),
    );
    yield* Effect.promise(() =>
      waitForCondition(() => requests.opened.length > 0, {
        timeoutMessage: 'Timed out waiting for the command request to open',
      }),
    );
    const opened = requests.opened[0]!;
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

describe('WolframTool approval', () => {
  afterEach(() => {
    for (const release of cleanups.splice(0)) release();
    vi.restoreAllMocks();
  });

  it.live('requests bash-style approval before executing wolframscript', () =>
    Effect.gen(function* () {
      const runId = 'a99f00000001' as RunId;
      const execute = vi
        .spyOn(toolUtils, 'runToolWithCheck')
        .mockResolvedValue({
          success: true,
          stdout: '2',
          stderr: '',
          timedOut: false,
          exitCode: 0,
        });

      const { result, permission, decide } = yield* dispatchWolfram(
        runId,
        '1+1',
      );
      expect(permission).toMatchObject({
        command: wolframApprovalCommand('1+1'),
        allowBypass: true,
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
