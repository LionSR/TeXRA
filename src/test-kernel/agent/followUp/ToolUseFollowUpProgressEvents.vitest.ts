import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { afterEach, describe, expect } from 'vitest';
import { registryOf } from '@agent/runtime/runRegistry';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import { untrackRun } from '@test/support/sessionEnd';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { queuedFollowUps } from '@test/support/sessionTestUtils';

import { seedTerminalRun } from '../progressTestUtils';

const runId = 'fa0001' as RunId;

describe('tool-use follow-up progress events', () => {
  const trackedRuns: Array<{
    readonly session: SessionHandle;
    readonly runId: RunId;
  }> = [];

  afterEach(() => {
    for (const { session, runId } of trackedRuns.splice(0)) {
      untrackRun(session.runs, runId);
    }
  });

  function trackRunControls(): void {
    const handle = testRunHandle({ runId, agent: 'search' });
    const owner = testDefaultSession();
    handle.attachControls({
      oneShot: false,
      requestImmediateCompaction: () => Effect.void,
      modelSwitchDisabledReason: () => Effect.succeed(undefined),
      switchModel: () => Effect.void,
    });
    registryOf(owner.runs).track(handle);
    trackedRuns.push({ session: owner, runId });
  }

  it.effect(
    'does not append through stale active contexts after final status',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          seedTerminalRun(testDefaultSession(), runId, RUN_OUTCOME.COMPLETED),
        );
        // A finished run's driver released its claim when its scope closed;
        // these rows stand in for that driver, so the claim they took goes
        // back here too: a hold taken and let go releases it.
        yield* Effect.scoped(
          testDefaultSession().log.hold(runId, { ends: true }),
        );
        trackRunControls();

        const result = yield* submitFollowUp(
          runId,
          {
            text: 'late follow-up',
            from: { kind: 'run' as const, runId: 'fa0002' as RunId },
          },
          {
            session: testDefaultSession(),
          },
        );

        // The run's terminal row stands: another run's message never
        // revives it, whatever controls a stale handle still holds.
        expect(result).toEqual({ status: 'failed', reason: 'not_resumable' });
        expect(yield* queuedFollowUps(testDefaultSession(), runId)).toEqual([]);
      }),
  );
});
