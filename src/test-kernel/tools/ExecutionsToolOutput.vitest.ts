// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { layer } from '@effect/vitest';

// Third-party imports
import { Effect, Fiber, Layer, Schema, Context } from 'effect';
import { afterEach, vi } from 'vitest';

// Local imports

import { type RunId, RunIdSchema } from '@texra-ai/harness/schemas';
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import { SessionLog } from '@shared/session/runHistory';
import { startAwaited } from '@test/support/runHandleFixtures';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { BashTool } from '@tools/bash';
import * as execUtils from '@utils/system/execUtils';
import type { ExecResult } from '@texra-ai/harness/node';

const PARENT_RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('ba5e00000001');

/** A call made under the parent run of `session`. */
const parentRunCall = (session: Context.Context<SessionServices>) =>
  nativeToolTestLayer({
    run: { session, runId: PARENT_RUN_ID, toolPolicy: {} },
  });

type ExecChunkSink = Pick<
  Parameters<typeof execUtils.executeCommand>[1] & object,
  'onStdout' | 'onStderr'
>;

/**
 * Launch a real background `bash` run whose mocked process emits `chunks`
 * synchronously and then stays open until `finish()` — the only way to
 * observe a mid-run read of the child stream's transcript log.
 */
function launchBackgroundRun(
  session: Context.Context<SessionServices>,
  emit: (sink: ExecChunkSink) => void,
) {
  return Effect.gen(function* () {
    let release!: (result: ExecResult) => void;
    const processExit = new Promise<ExecResult>((resolve) => {
      release = resolve;
    });

    let emitted!: () => void;
    const outputEmitted = new Promise<void>((resolve) => {
      emitted = resolve;
    });
    vi.spyOn(execUtils, 'executeCommand').mockImplementation(
      (_command, options) =>
        Effect.suspend(() => {
          emit(options);
          emitted();
          return Effect.promise(() => processExit);
        }),
    );
    // The completion commits on the parent's input; its wake follows.
    const followUp = vi
      .spyOn(toolUseFollowUp, 'wakeIfOwed')
      .mockReturnValue(Effect.succeed(Effect.void));

    publishTestRunStart(session, PARENT_RUN_ID);
    // No settle before the launch. `registerRun` opens the parent check with an
    // empty batch on the session's publisher, so the child's admission read
    // runs after the parent's queued `run.start`. Settling here instead would
    // make this suite pass whether or not that barrier exists.
    const launched = yield* BashTool.call({
      command: 'make build',
      run_in_background: true,
    }).pipe(Effect.provide(parentRunCall(session)));

    yield* Effect.promise(() => outputEmitted);
    yield* Context.get(session, SessionLog).settled;
    const reported = /Run ID: (\S+)/.exec(launched.output ?? '')?.[1];
    assert.ok(reported, 'Background launch should report its run ID');
    const runId = Schema.decodeUnknownSync(RunIdSchema)(reported);

    return {
      runId,
      finish: async () => {
        release({
          success: true,
          stdout: '',
          stderr: '',
          timedOut: false,
          exitCode: 0,
        });
        await vi.waitFor(() => {
          assert.ok(
            followUp.mock.calls.length > 0,
            'Background run should deliver a completion follow-up',
          );
        });
      },
    };
  });
}

function readOutput(
  session: Context.Context<SessionServices>,
  runId: RunId,
  viewRange?: [number, number],
) {
  return Effect.gen(function* () {
    yield* Context.get(session, SessionLog).settled;
    return yield* ExecutionsTool.call({
      path: `/executions/${runId}/output`,
      ...(viewRange ? { view_range: viewRange } : {}),
    }).pipe(Effect.provide(parentRunCall(session)));
  });
}

/** The test's session over the host's roots, as the harness holds it. */
const sessionHandle = Effect.flatMap(TestSession, sessionHandleOf);

/** A fresh host per test, and a session over its roots whose requests a
 *  person answers from the view. */
const perTest = Layer.provideMerge(
  TestSession.layer(undefined, { host: {} }),
  FakeHost.layer({
    workspacePath: '/workspace',
    config: { approvalPolicy: 'yolo' },
  }),
);

// Live clock: the background run settles on real turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'ExecutionsTool /executions/{id}/output',
  (it) => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.layer(perTest, { buildPerTest: true })((it) => {
      it.effect(
        'returns a running background command output so far, with stderr marked',
        () =>
          Effect.gen(function* () {
            const session = yield* sessionHandle;
            const run = yield* launchBackgroundRun(session, (sink) => {
              sink.onStdout?.('[ 42%] Building CXX object src/foo.cc.o\n');
              sink.onStderr?.("warning: unused variable 'x'\n");
              sink.onStdout?.('[ 84%] Building CXX object src/bar.cc.o\n');
            });

            const result = yield* readOutput(session, run.runId);

            const output = result.output ?? '';
            assert.ok(
              output.includes('[ 42%] Building CXX object src/foo.cc.o'),
            );
            assert.ok(output.includes("err: warning: unused variable 'x'"));
            assert.ok(
              output.includes('[ 84%] Building CXX object src/bar.cc.o'),
            );
            assert.ok(output.includes('[still running'));
            // stdout rows must not be marked as stderr.
            assert.ok(!output.includes('err: [ 42%]'));
            // Arrival order, not stdout-then-stderr sections.
            assert.ok(
              output.indexOf("err: warning: unused variable 'x'") <
                output.indexOf('[ 84%] Building CXX object src/bar.cc.o'),
              'stdout/stderr interleaving must survive the projection',
            );

            yield* Effect.promise(() => run.finish());
          }),
      );

      it.effect(
        'kills a child whose launch is in flight before its program runs',
        () =>
          Effect.gen(function* () {
            const session = yield* sessionHandle;
            publishTestRunStart(session, PARENT_RUN_ID);
            const childId = publishTestRunStart(session, undefined, {
              parent: PARENT_RUN_ID,
            });
            yield* Context.get(session, SessionLog).settled;
            // Launched and admitted, its program not yet past its setup: the
            // window between `start` and the child's loop being under way.
            const launch = yield* Effect.forkChild(
              startAwaited(
                Context.get(session, Runs),
                childId,
                Effect.never,
                PARENT_RUN_ID,
              ),
              { startImmediately: true },
            );

            const result = yield* ExecutionsTool.call({
              path: `/executions/${childId}`,
              action: 'kill',
            }).pipe(Effect.provide(parentRunCall(session)));

            assert.equal(result.output, `Run ${childId} terminated.`);
            yield* Fiber.await(launch);
          }),
      );
    });
  },
);
