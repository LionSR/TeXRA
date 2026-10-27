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
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { BashTool } from '@tools/bash';
import * as execUtils from '@utils/system/execUtils';

// Local file imports

type ExecuteCommandOptions = NonNullable<
  Parameters<typeof execUtils.executeCommand>[1]
>;

/**
 * Stub `executeCommand` so it emits streamed chunks through the callbacks the
 * tool passes in, then settles with a successful zero-exit result unless the
 * case overrides part of it.
 */
function mockStreamingCommand(
  stream: (options: ExecuteCommandOptions) => void,
  result: Partial<ExecResult> = {},
): void {
  vi.spyOn(execUtils, 'executeCommand').mockImplementation(
    (_command, options) =>
      Effect.sync(() => {
        stream(options);
        return {
          success: true,
          stdout: '',
          stderr: '',
          timedOut: false,
          exitCode: 0,
          ...result,
        };
      }),
  );
}

/** The successful zero-exit result most background-launch cases settle with. */
const DONE_EXEC_RESULT: ExecResult = {
  success: true,
  stdout: 'done\n',
  stderr: '',
  timedOut: false,
  exitCode: 0,
};

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

/** Shared teardown for background-launch cases. */
function detachBackgroundRun(parentRunId: RunId): void {
  // A teardown that runs in `finally`, so the close runs on its own.
  Effect.runFork(testDefaultSession().followUps.closeInput(parentRunId));
}

/**
 * A parent run the run history already knows: its one `run.start` has landed, so
 * the parking and the launch that follow append to a run that began exactly
 * once. A second `run.start` on the same aggregate is refused by the seq-1
 * rule, and that refusal is a lost publication the next settle reports.
 */
function startedParentRun(): RunId {
  return publishTestRunStart(testDefaultSession());
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

/** The one run id a background launch reports in its output. */
function launchedIds(result: ToolResult): {
  output: string;
  runId: RunId | undefined;
} {
  const output = String(result.output ?? '');
  return {
    output,
    runId: /Run ID: (\S+)/.exec(output)?.[1] as RunId | undefined,
  };
}

function launchBackgroundBash(parentRunId: RunId) {
  // No settle before the launch. `registerRun` opens the parent check with an
  // empty batch on the session's publisher, so a child's admission read runs
  // after every fact its parent queued, this parent's `run.start` included.
  // Settling here instead would make this suite pass whether or not that
  // barrier exists.
  return backgroundBashCall(parentRunId);
}

function backgroundBashCall(parentRunId: RunId) {
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
      mockStreamingCommand((options) => options.onStdout?.(text));

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
          Effect.succeed(DONE_EXEC_RESULT),
        );

        const parentRunId = startedParentRun();
        let handleAtResumeTime: unknown;
        let runId = '' as RunId;
        const wakeReached = Deferred.makeUnsafe<void>();
        yield* Effect.promise(() => installPlatform(BASH_PLATFORM_OPTIONS));
        // The resume a wake starts is the run's one resume in flight.
        const followUps = testDefaultSession().followUps;
        const resumeOnce = followUps.resumes.once.bind(followUps.resumes);
        const tryResumeRun = vi
          .spyOn(followUps.resumes, 'once')
          .mockImplementation((resumed, resume) => {
            Deferred.doneUnsafe(wakeReached, Effect.void);
            handleAtResumeTime ??= testDefaultSession().runs.get(runId)?.handle;
            return resumeOnce(resumed, resume);
          });
        yield* Effect.promise(() => parkRunWaiting(parentRunId));

        try {
          const launchResult = yield* launchBackgroundBash(parentRunId);
          assert.equal(launchResult.status, 'executed');
          const launched = launchedIds(launchResult);
          assert.ok(launched.runId, 'Launch output should report a run id');
          runId = launched.runId;

          yield* Deferred.await(wakeReached);
          assert.ok(
            tryResumeRun.mock.calls.length > 0,
            'Background bash completion should reach the wake step',
          );
          // The wake step was reached — this run must already be untracked
          // (finalized), never still RUNNING, so a resumed parent that waits on
          // it right now resolves immediately instead of racing its own wake.
          assert.equal(handleAtResumeTime, undefined);
          assert.equal(testDefaultSession().runs.get(runId)?.handle, undefined);
        } finally {
          detachBackgroundRun(parentRunId);
        }
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
    'persists a killed background command as interrupted, not failed',
    () =>
      Effect.gen(function* () {
        const resolveCommand = holdCommand();
        yield* Effect.promise(() => installPlatform(BASH_PLATFORM_OPTIONS));
        const parentRunId = startedParentRun();

        const launchResult = yield* launchBackgroundBash(parentRunId);
        const { output, runId } = launchedIds(launchResult);
        assert.ok(runId, output);

        // The user stop lands CANCELLED on the run phase; only afterwards does
        // the killed process report its non-zero exit.
        const stopped = testDefaultSession().runs.stop(runId, {
          reason: 'user',
        });
        assert.equal(stopped.accepted(), true);
        const stopSettlement = yield* Effect.forkChild(stopped.settlement);
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
});
