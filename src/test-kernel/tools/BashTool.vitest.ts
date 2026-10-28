// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';

// Third-party imports
import { Deferred, Effect, Fiber, Schedule } from 'effect';
import { beforeEach, afterEach, describe, vi } from 'vitest';

// Local imports
import { getRunRecords } from '@agent/storage/runRecords';

import {
  RUN_OUTCOME,
  qualifyAggregateId,
  RUN_PHASE,
  type ExecResult,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createProcessSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { BashTool } from '@tools/bash';
import * as execUtils from '@utils/system/execUtils';

/**
 * Stub `executeCommand` to park until the test settles it. Returns the
 * resolver so the case can interleave assertions before the (mocked) process
 * settles.
 */
function holdCommand(): (result: ExecResult) => void {
  const command = Deferred.makeUnsafe<ExecResult>();
  vi.spyOn(execUtils, 'executeCommand').mockImplementation(() =>
    Deferred.await(command),
  );
  return (result) => {
    Deferred.doneUnsafe(command, Effect.succeed(result));
  };
}

/** Close the parent's input so the background run's delivery ends. */
function detachBackgroundRun(parentRunId: RunId): void {
  Effect.runFork(testDefaultSession().followUps.closeInput(parentRunId));
}

/**
 * Park a run WAITING the way its loop does: the `waiting` flow step is the
 * fact the fold reads the phase from, so the delivery path sees the same
 * parked parent a real run would.
 */
async function parkRunWaiting(runId: RunId): Promise<void> {
  const session = testDefaultSession();
  publishTestRows(session, [
    {
      type: 'run.position',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', at: 'waiting' },
    },
  ]);
  await vi.waitFor(() => {
    assert.equal(
      testDefaultSession().view.run(runId)?.status,
      RUN_PHASE.WAITING,
    );
  });
}

// Unit tests exercise the tool directly — no approval host is wired.
const BASH_PLATFORM_OPTIONS = {
  workspacePath: '/workspace',
  config: { 'texra.toolUse.requireBashApproval': false },
} as const;

/** The run id a background launch reports in its output. */
function launchedRunId(result: ToolResult): RunId | undefined {
  return /Run ID: (\S+)/.exec(String(result.output ?? ''))?.[1] as
    RunId | undefined;
}

function launchBackgroundBash(parentRunId: RunId) {
  // No settle before the launch. `registerRun` opens the parent check with an
  // empty batch on the session's publisher, so a child's admission read runs
  // after every fact its parent queued, this parent's `run.start` included.
  // Settling here instead would make this suite pass whether or not that
  // barrier exists.
  return BashTool.call({
    command: 'make build',
    run_in_background: true,
  }).pipe(
    Effect.provide(
      nativeToolTestLayer({
        run: {
          session: testDefaultSession(),
          runId: parentRunId,
          toolPolicy: {},
        },
      }),
    ),
  );
}

describe('BashTool', () => {
  setupPlatform(BASH_PLATFORM_OPTIONS);
  beforeEach(async () => {
    await Effect.runPromise(createProcessSession());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.live.each([
    {
      name: 'head boundary',
      text: `${'a'.repeat(3_999)}🙂${'b'.repeat(60_000)}`,
    },
    {
      name: 'tail boundary',
      text: `${'a'.repeat(4_001)}🙂${'b'.repeat(50_000)}`,
    },
  ])('does not split surrogate pairs at the $name', ({ text }) =>
    Effect.gen(function* () {
      vi.spyOn(execUtils, 'executeCommand').mockImplementation(
        (_command, options) =>
          Effect.sync(() => {
            options?.onStdout?.(text);
            return {
              success: true,
              stdout: '',
              stderr: '',
              timedOut: false,
              exitCode: 0,
            };
          }),
      );

      const result = yield* BashTool.call({
        command: 'unicode-boundary',
      });
      const output = String(result.output);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(output));
      assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(output));
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live(
    '#8093 regression: finalizes the background run before its wake step resolves, so a resumed parent never self-stalls waiting on it',
    () =>
      Effect.gen(function* () {
        // Regression: waking a WAITING parent (`resumeOnSession`) can
        // await the ENTIRE resumed parent turn. If that wake were awaited before
        // this run's own finalize (as it used to be, delivering via a
        // single wake-aware call before `finalizeBackground`), a resumed parent
        // that immediately calls `executions` with action=wait on this same
        // run could find it still RUNNING and block on itself for the
        // whole wait budget. Prove the ordering: hold the resume open and
        // confirm the run is already untracked (terminal) by the time the
        // resume is even invoked.
        vi.spyOn(execUtils, 'executeCommand').mockReturnValue(
          Effect.succeed({
            success: true,
            stdout: 'done\n',
            stderr: '',
            timedOut: false,
            exitCode: 0,
          }),
        );

        const parentRunId = publishTestRunStart(testDefaultSession());
        let handleAtResumeTime: unknown;
        let runId = '' as RunId;
        const wakeReached = Deferred.makeUnsafe<void>();
        // The resume a wake starts is the run's one resume in flight.
        const followUps = testDefaultSession().followUps;
        const resumeOnce = followUps.resumes.once.bind(followUps.resumes);
        vi.spyOn(followUps.resumes, 'once').mockImplementation(
          (resumed, resume, fork) => {
            Deferred.doneUnsafe(wakeReached, Effect.void);
            handleAtResumeTime ??= testDefaultSession().runs.get(runId)?.handle;
            return resumeOnce(resumed, resume, fork);
          },
        );
        yield* Effect.promise(() => parkRunWaiting(parentRunId));

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => detachBackgroundRun(parentRunId)),
        );
        const launched = launchedRunId(
          yield* launchBackgroundBash(parentRunId),
        );
        assert.ok(launched, 'Launch output should report a run id');
        runId = launched;

        yield* Deferred.await(wakeReached);
        // The wake step was reached — this run must already be untracked
        // (finalized), never still RUNNING, so a resumed parent that waits on
        // it right now resolves immediately instead of racing its own wake.
        assert.equal(handleAtResumeTime, undefined);
        assert.equal(testDefaultSession().runs.get(runId)?.handle, undefined);
      }),
  );

  it.live(
    'persists a killed background command as interrupted, not failed',
    () =>
      Effect.gen(function* () {
        const resolveCommand = holdCommand();
        const parentRunId = publishTestRunStart(testDefaultSession());

        const runId = launchedRunId(yield* launchBackgroundBash(parentRunId));
        assert.ok(runId, 'Launch output should report a run id');

        // The user stop lands CANCELLED on the run phase; only afterwards does
        // the killed process report its non-zero exit.
        const stopSettlement = yield* Effect.forkChild(
          testDefaultSession().runs.stop(runId, { reason: 'user' }).settlement,
        );
        resolveCommand({
          success: false,
          stdout: '',
          stderr: 'Terminated\n',
          timedOut: false,
          exitCode: 143,
        });

        yield* Fiber.join(stopSettlement);
        const records = getRunRecords(testDefaultSession(), runId);
        yield* records.readRunEnd().pipe(
          Effect.repeat({
            while: (end) => end?.outcome !== RUN_OUTCOME.CANCELLED,
            schedule: Schedule.spaced('10 millis'),
          }),
          Effect.timeout('1 second'),
        );
        detachBackgroundRun(parentRunId);
      }),
  );
});
