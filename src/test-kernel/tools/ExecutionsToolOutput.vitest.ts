// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';

// Third-party imports
import { Effect, Schema } from 'effect';
import { beforeEach, afterEach, describe, vi } from 'vitest';

// Local imports
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';

import { type ExecResult, RunIdSchema, type RunId } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { BashTool } from '@tools/bash';
import * as execUtils from '@utils/system/execUtils';

const PARENT_RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('ba5e00000001');

type ExecChunkSink = Pick<
  Parameters<typeof execUtils.executeCommand>[1] & object,
  'onStdout' | 'onStderr'
>;

/**
 * Launch a real background `bash` run whose mocked process emits `chunks`
 * synchronously and then stays open until `finish()` — the only way to
 * observe a mid-run read of the child stream's transcript log.
 */
function launchBackgroundRun(emit: (sink: ExecChunkSink) => void) {
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
      .spyOn(toolUseFollowUp, 'startFollowUpWake')
      .mockReturnValue(Effect.succeed(Effect.void));

    publishTestRunStart(testDefaultSession(), PARENT_RUN_ID);
    // No settle before the launch. `registerRun` opens the parent check with an
    // empty batch on the session's publisher, so the child's admission read
    // runs after the parent's queued `run.start`. Settling here instead would
    // make this suite pass whether or not that barrier exists.
    const launched = yield* BashTool.call({
      command: 'make build',
      run_in_background: true,
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: PARENT_RUN_ID,
            toolPolicy: {},
          },
        }),
      ),
    );

    assert.equal(launched.status, 'executed');
    yield* Effect.promise(() => outputEmitted);
    yield* testDefaultSession().log.settled;
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

function readOutput(runId: RunId, viewRange?: [number, number]) {
  return Effect.gen(function* () {
    yield* testDefaultSession().log.settled;
    return yield* ExecutionsTool.call({
      path: `/executions/${runId}/output`,
      ...(viewRange ? { view_range: viewRange } : {}),
    });
  });
}

describe('ExecutionsTool /executions/{id}/output', () => {
  setupPlatform({
    workspacePath: '/workspace',
    config: { 'texra.toolUse.requireBashApproval': false },
  });

  beforeEach(async () => {
    await Effect.runPromise(createProcessSession());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.live(
    'returns a running background command output so far, with stderr marked',
    () =>
      Effect.gen(function* () {
        const run = yield* launchBackgroundRun((sink) => {
          sink.onStdout?.('[ 42%] Building CXX object src/foo.cc.o\n');
          sink.onStderr?.("warning: unused variable 'x'\n");
          sink.onStdout?.('[ 84%] Building CXX object src/bar.cc.o\n');
        });

        const result = yield* readOutput(run.runId);

        assert.equal(result.status, 'executed');
        const output = result.output ?? '';
        assert.match(output, /^Output for \S+ \(process, running/);
        assert.match(
          output,
          /: [\d,]+ retained transcript chars; command-output cap 200,000 chars, 3 lines\./,
        );
        assert.ok(!output.includes('of 200,000 logged chars'));
        assert.ok(output.includes('[ 42%] Building CXX object src/foo.cc.o'));
        assert.ok(output.includes("err: warning: unused variable 'x'"));
        assert.ok(output.includes('[ 84%] Building CXX object src/bar.cc.o'));
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
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: testDefaultSession(),
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );
});
