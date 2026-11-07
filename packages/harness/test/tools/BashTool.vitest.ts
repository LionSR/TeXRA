// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { layer } from '@effect/vitest';

// Third-party imports
import { Deferred, Effect, Layer, Schedule, Schema, Context } from 'effect';
import { afterEach, vi } from 'vitest';

// Local imports

import {
  APPROVAL_POLICY_SETTING,
  qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
  RunIdSchema,
} from '@texra-ai/harness/schemas';
import * as resumeRunModule from '@agent/runtime/resumeRun';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { getRunRecords } from '@agent/storage/runOwnership';
import { Inbox } from '@agent/followUp/Inbox';
import { SessionViewAccess } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { BashTool } from '@tools/bash';
import * as execUtils from '@utils/system/execUtils';
import type { ToolResult } from '@texra-ai/harness';
import type { ExecResult } from '@texra-ai/harness/node';

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
function detachBackgroundRun(
  session: Context.Context<SessionServices>,
  parentRunId: RunId,
): void {
  Effect.runFork(Context.get(session, Inbox).closeInput(parentRunId));
}

/**
 * Park a run WAITING the way its loop does: the `waiting` flow step is the
 * fact the fold reads the phase from, so the delivery path sees the same
 * parked parent a real run would.
 */
async function parkRunWaiting(
  session: Context.Context<SessionServices>,
  runId: RunId,
): Promise<void> {
  await Effect.runPromise(
    publishTestRows(session, [
      {
        type: 'run.position',
        aggregateId: qualifyAggregateId('run', runId),
        payload: { family: 'toolUse', at: 'waiting' },
      },
    ]),
  );
  await vi.waitFor(() => {
    assert.equal(
      Context.get(session, SessionViewAccess).run(runId)?.position,
      'waiting',
    );
  });
}

// Unit tests exercise the tool directly — no approval host is wired.
const BASH_PLATFORM_OPTIONS = {
  workspaceRoot: '/workspace',
  config: { [APPROVAL_POLICY_SETTING.key]: 'yolo' },
} as const;

/** The run id a background launch reports in its output. */
function launchedRunId(result: ToolResult): RunId | undefined {
  const reported = /Run ID: (\S+)/.exec(String(result.output ?? ''))?.[1];
  return reported === undefined
    ? undefined
    : Schema.decodeSync(RunIdSchema)(reported);
}

function launchBackgroundBash(
  session: Context.Context<SessionServices>,
  parentRunId: RunId,
) {
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
        run: { session, runId: parentRunId, toolPolicy: {} },
      }),
    ),
  );
}

/** The test's session over the host's roots, as the harness holds it. */
const sessionHandle = Effect.flatMap(TestSession, sessionHandleOf);

// Live clock: the background runs settle on real turns.
layer(SessionGraph.hosted, { excludeTestServices: true })('BashTool', (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A fresh host per test, and a session over its roots whose requests a
  // person answers from the view.
  const perTest = Layer.provideMerge(
    TestSession.layer(undefined, { host: {} }),
    FakeHost.layer(BASH_PLATFORM_OPTIONS),
  );

  it.layer(perTest, { buildPerTest: true })((it) => {
    it.effect(
      '#8093 regression: the background run has ended and left the registry before its parent is woken, so a resumed parent never self-stalls waiting on it',
      () =>
        Effect.gen(function* () {
          // Regression: a resumed parent that at once calls `executions`
          // with action=wait on this run must find it done, never still
          // held here, or it blocks on its own wake for the whole wait
          // budget. The registry wakes the parent for the delivered result
          // only once the run's fiber, which wrote the run's end, has left
          // it: prove the order by reading, as the wake's resume begins,
          // whether a wait would skip the run.
          vi.spyOn(execUtils, 'executeCommand').mockReturnValue(
            Effect.succeed({
              success: true,
              stdout: 'done\n',
              stderr: '',
              timedOut: false,
              exitCode: 0,
            }),
          );

          const session = yield* sessionHandle;
          const parentRunId = yield* publishTestRunStart(session);
          let skippedAtResumeTime: boolean | undefined;
          // cast: '' names no run until the launch reports its id.
          let runId = '' as RunId;
          const wakeReached = Deferred.makeUnsafe<void>();
          // The parent's wake for the delivered result is its resume.
          const resume = resumeRunModule.resumeRun;
          vi.spyOn(resumeRunModule, 'resumeRun').mockImplementation(
            (woken, options) => {
              if (woken === parentRunId) {
                // A wait is over once no launch of the run is held here.
                skippedAtResumeTime ??=
                  Context.get(session, Runs).get(runId) === undefined;
                Deferred.doneUnsafe(wakeReached, Effect.void);
              }
              return resume(woken, options);
            },
          );
          yield* Effect.promise(() => parkRunWaiting(session, parentRunId));

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => detachBackgroundRun(session, parentRunId)),
          );
          const launched = launchedRunId(
            yield* launchBackgroundBash(session, parentRunId),
          );
          assert.ok(launched, 'Launch output should report a run id');
          runId = launched;

          yield* Deferred.await(wakeReached);
          // The wake was reached: this run has ended and is no longer held,
          // so a resumed parent that waits on it right now resolves at once
          // instead of racing its own wake.
          assert.equal(skippedAtResumeTime, true);
        }),
    );

    it.effect(
      'keeps a long foreground output head contiguous when its cut splits a surrogate pair',
      () =>
        Effect.gen(function* () {
          // The 4,000-character head budget ends inside the emoji, so the
          // head stops one short of it; the next chunk is not part of it.
          const first = `${'a'.repeat(3_999)}😀${'z'.repeat(10)}`;
          vi.spyOn(execUtils, 'executeCommand').mockImplementation(
            (_command, options) =>
              Effect.sync(() => {
                options?.onStdout?.(first);
                options?.onStdout?.('b'.repeat(60_000));
                return {
                  success: true,
                  stdout: '',
                  stderr: '',
                  timedOut: false,
                  exitCode: 0,
                };
              }),
          );

          const result = yield* BashTool.call({ command: 'make build' }).pipe(
            Effect.provide(nativeToolTestLayer()),
          );

          const [head] = String(result.output ?? '').split('\n\n[... ');
          assert.equal(head, 'a'.repeat(3_999));
        }),
    );

    it.effect(
      'persists a killed background command as interrupted, not failed',
      () =>
        Effect.gen(function* () {
          const resolveCommand = holdCommand();
          const session = yield* sessionHandle;
          const parentRunId = yield* publishTestRunStart(session);

          const runId = launchedRunId(
            yield* launchBackgroundBash(session, parentRunId),
          );
          assert.ok(runId, 'Launch output should report a run id');

          // The user stop records its reason and interrupts the run's loop;
          // the killed process's non-zero exit, reported after, is not the
          // run's outcome.
          assert.equal(
            yield* Context.get(session, Runs).stop(runId, 'user'),
            true,
          );
          resolveCommand({
            success: false,
            stdout: '',
            stderr: 'Terminated\n',
            timedOut: false,
            exitCode: 143,
          });

          yield* getRunRecords(runId)
            .readRunEnd()
            .pipe(
              Effect.repeat({
                while: (end) => end?.outcome !== RUN_OUTCOME.CANCELLED,
                schedule: Schedule.spaced('10 millis'),
              }),
              Effect.timeout('1 second'),
              Effect.provide(session),
            );
          detachBackgroundRun(session, parentRunId);
        }),
    );
  });
});
