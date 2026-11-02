// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { layer } from '@effect/vitest';

// Third-party imports
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schedule,
  SubscriptionRef,
  Context,
} from 'effect';
import { afterEach, vi } from 'vitest';

// Local imports

import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
} from '@texra-ai/harness/schemas';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { getRunRecords } from '@agent/storage/runRecords';
import { Inbox } from '@agent/followUp/ToolUseFollowUp';
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
import { shouldSkipWait } from '@tools/executions/waitCoordination';
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
  publishTestRows(session, [
    {
      type: 'run.position',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', at: 'waiting' },
    },
  ]);
  await vi.waitFor(() => {
    assert.equal(
      Context.get(session, SessionViewAccess).run(runId)?.status,
      RUN_PHASE.WAITING,
    );
  });
}

// Unit tests exercise the tool directly — no approval host is wired.
const BASH_PLATFORM_OPTIONS = {
  workspacePath: '/workspace',
  config: { 'toolUse.requireBashApproval': false },
} as const;

/** The run id a background launch reports in its output. */
function launchedRunId(result: ToolResult): RunId | undefined {
  return /Run ID: (\S+)/.exec(String(result.output ?? ''))?.[1] as
    RunId | undefined;
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
layer(SessionGraph.layer, { excludeTestServices: true })('BashTool', (it) => {
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
    it.effect.each([
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
        const session = yield* sessionHandle;
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
        }).pipe(
          Effect.provide(
            nativeToolTestLayer({
              run: { session, runId: 'bash-tool' as RunId, toolPolicy: {} },
            }),
          ),
        );
        const output = String(result.output);
        assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(output));
        assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(output));
      }),
    );

    it.effect(
      '#8093 regression: finalizes the background run before its wake step resolves, so a resumed parent never self-stalls waiting on it',
      () =>
        Effect.gen(function* () {
          // Regression: waking a WAITING parent (`wakeRun`) can
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

          const session = yield* sessionHandle;
          const parentRunId = publishTestRunStart(session);
          let skippedAtResumeTime: boolean | undefined;
          let runId = '' as RunId;
          const wakeReached = Deferred.makeUnsafe<void>();
          // The resume a wake starts is the run's one resume in flight.
          const { programs } = registryOf(Context.get(session, Runs));
          const decide = programs.resume;
          vi.spyOn(programs, 'resume').mockImplementation((...args) => {
            skippedAtResumeTime ??= shouldSkipWait(
              Context.get(session, Runs),
              SubscriptionRef.getUnsafe(
                Context.get(session, SessionViewAccess).ref,
              ),
              runId,
            );
            Deferred.doneUnsafe(wakeReached, Effect.void);
            return decide(...args);
          });
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
          // The wake step was reached — this run must already be finalized,
          // never still RUNNING, so a resumed parent that waits on it right now
          // resolves immediately instead of racing its own wake.
          assert.equal(skippedAtResumeTime, true);
        }),
    );

    it.effect(
      'persists a killed background command as interrupted, not failed',
      () =>
        Effect.gen(function* () {
          const resolveCommand = holdCommand();
          const session = yield* sessionHandle;
          const parentRunId = publishTestRunStart(session);

          const runId = launchedRunId(
            yield* launchBackgroundBash(session, parentRunId),
          );
          assert.ok(runId, 'Launch output should report a run id');

          // The user stop lands CANCELLED on the run phase; only afterwards does
          // the killed process report its non-zero exit.
          const stopSettlement = yield* Effect.forkChild(
            Context.get(session, Runs)
              .stop(runId, { reason: 'user' })
              .settlement.pipe(Effect.provide(session)),
          );
          resolveCommand({
            success: false,
            stdout: '',
            stderr: 'Terminated\n',
            timedOut: false,
            exitCode: 143,
          });

          yield* Fiber.join(stopSettlement);
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
