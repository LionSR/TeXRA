// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';

// Third-party imports
import { Effect } from 'effect';
import { beforeEach, afterEach, describe, vi } from 'vitest';

// Local imports
import { registerRun } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';

import {
  aggregateId,
  LOG_LEVELS,
  MESSAGE_TYPES,
  type ExecResult,
  RunIdSchema,
  type RunId,
} from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createProcessSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { BashTool } from '@tools/bash';
import { generateRunId } from '@utils/core';
import * as execUtils from '@utils/system/execUtils';

const PARENT_RUN_ID = RunIdSchema.parse('ba5e00000001');

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
    const followUp = vi
      .spyOn(toolUseFollowUp, 'submitFollowUp')
      .mockReturnValue(Effect.succeed({ status: 'sent' }));

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
    const runId = RunIdSchema.parse(reported);

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

/** Register a process-identity bash run and return its run id. */
function registerProcessRun(instruction: string) {
  return Effect.gen(function* () {
    const runId = generateRunId();
    yield* registerRun(
      testDefaultSession(),
      runId,
      AgentConfigSchema.parse({
        agent: 'bash',
        instruction,
      }),
      { identity: { kind: 'process', tool: 'bash' } },
    );
    return runId;
  });
}

/**
 * Register a background script run and return its id. A script run publishes
 * its `run.config` the way `createChildRun` does at launch, so the fold sees
 * the model the launch actually routed.
 */
function registerScriptRun(name: string, model?: string) {
  return Effect.gen(function* () {
    const runId = generateRunId();
    yield* registerRun(
      testDefaultSession(),
      runId,
      {
        name,
        instruction: `Script ${name}`,
        ...(model === undefined ? {} : { model }),
      },
      { identity: { kind: 'script', title: name } },
    );
    if (model !== undefined) {
      const session = testDefaultSession();
      publishTestRows(session, [
        {
          type: 'run.config',
          aggregateId: aggregateId('run', runId),
          config: AgentConfigSchema.parse({
            agent: name,
            model,
            instruction: `Script '${name}'`,
          }),
        },
      ]);
      yield* session.log.settled;
    }
    return runId;
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

  it.live(
    'keeps final unterminated stdout separate from completion lifecycle output',
    () =>
      Effect.gen(function* () {
        const run = yield* launchBackgroundRun((sink) => {
          sink.onStdout?.('tail without newline');
        });
        yield* Effect.promise(() => run.finish());

        const result = yield* readOutput(run.runId);
        const output = result.output ?? '';

        assert.ok(
          output.includes('tail without newline\nTurn completed in '),
          output,
        );
        assert.ok(!output.includes('tail without newlineTurn completed in '));
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

  it.live(
    'joins chunks that split a line and pages the projection with view_range',
    () =>
      Effect.gen(function* () {
        const run = yield* launchBackgroundRun((sink) => {
          // A single logical line delivered across two stdout chunks.
          sink.onStdout?.('line1\nline2\nli');
          sink.onStdout?.('ne3\nline4\nline5\n');
        });

        const full = yield* readOutput(run.runId);
        assert.ok(
          (full.output ?? '').includes('line3'),
          'A line split across chunks must be rejoined, not broken in two',
        );

        const paged = yield* readOutput(run.runId, [2, 3]);
        const output = paged.output ?? '';
        assert.equal(paged.status, 'executed');
        assert.ok(output.includes('Showing lines 2-3 of 5.'));
        assert.ok(output.includes('line2'));
        assert.ok(output.includes('line3'));
        assert.ok(!output.includes('line1'));
        assert.ok(!output.includes('line4'));

        const past = yield* readOutput(run.runId, [900, 950]);
        assert.equal(past.status, 'executed');
        assert.ok(
          (past.output ?? '').includes('No lines in the requested range'),
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

  it.live(
    'reconstructs split chunks, flushes source switches, and normalizes line breaks',
    () =>
      Effect.gen(function* () {
        const run = yield* launchBackgroundRun((sink) => {
          sink.onStdout?.('complete\r');
          sink.onStdout?.('\n\npartial\r');
          sink.onStderr?.('warn');
          sink.onStderr?.('ing\r');
          sink.onStderr?.('\n\nlast err\r');
          sink.onStdout?.('tail');
        });

        const result = yield* readOutput(run.runId);
        const output = result.output ?? '';

        assert.ok(output.includes('Showing lines 1-7 of 7.'));
        assert.ok(
          output.includes(
            'complete\n\npartial\nerr: warning\nerr: \nerr: last err\ntail',
          ),
        );
        assert.ok(!output.includes('\r'));
        assert.equal(output.match(/^err: /gm)?.length, 3);

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

  it.live('renders consecutive untagged legacy rows standalone', () =>
    Effect.gen(function* () {
      const runId = yield* registerProcessRun('legacy command');
      const session = testDefaultSession();
      const append = (
        text: string,
        level:
          typeof LOG_LEVELS.INFO | typeof LOG_LEVELS.WARN = LOG_LEVELS.INFO,
      ): void => {
        publishTestRows(session, [
          {
            type: 'log',
            aggregateId: aggregateId('run', runId),
            level,
            messageType: MESSAGE_TYPES.DEFAULT,
            message: text,
          },
        ]);
      };
      append('legacy one');
      append('legacy two');
      append('legacy warning\r\n\rlegacy tail\r', LOG_LEVELS.WARN);

      const result = yield* readOutput(runId);
      const output = result.output ?? '';

      assert.ok(output.includes('Showing lines 1-5 of 5.'));
      assert.ok(
        output.includes(
          'legacy one\nlegacy two\nerr: legacy warning\nerr: \nerr: legacy tail',
        ),
      );
      assert.ok(!output.includes('legacy onelegacy two'));
      assert.ok(!output.includes('\r'));
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

  it.live('treats a carriage-return progress redraw as separate lines', () =>
    Effect.gen(function* () {
      // curl/pip/docker redraw with `\r` and no newline. Splitting on LF alone
      // would make the whole progress bar one enormous line, so the bounded
      // window would still hand back the entire log.
      const run = yield* launchBackgroundRun((sink) => {
        sink.onStdout?.('  0%\r 50%\r100%\r\ndownload complete\n');
      });

      const result = yield* readOutput(run.runId);
      const output = result.output ?? '';

      assert.ok(output.includes('Showing lines 1-4 of 4.'));
      assert.ok(output.includes('  0%'));
      assert.ok(output.includes('download complete'));

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

  it.live(
    'bounds a chatty log to its tail by default and says how to page back',
    () =>
      Effect.gen(function* () {
        const lineCount = 1500;
        const run = yield* launchBackgroundRun((sink) => {
          sink.onStdout?.(
            `${Array.from({ length: lineCount }, (_, i) => `line${i + 1}`).join('\n')}\n`,
          );
        });

        const result = yield* readOutput(run.runId);
        const output = result.output ?? '';

        assert.ok(
          output.includes(`Showing lines 1301-${lineCount} of ${lineCount}`),
          `Default window should be the last 200 lines, got: ${output.slice(0, 300)}`,
        );
        assert.ok(output.includes('the last 200 by default'));
        assert.ok(output.includes('line1500'));
        assert.ok(output.includes('line1301'));
        assert.ok(!output.includes('line1300\n'));

        // A wide view_range still cannot pull back an unbounded window.
        const wide = yield* readOutput(run.runId, [1, lineCount]);
        const wideOutput = wide.output ?? '';
        assert.ok(wideOutput.includes(`Showing lines 1-1000 of ${lineCount}`));
        assert.ok(wideOutput.includes('capped at 1000 lines per read'));
        assert.ok(wideOutput.includes('view_range: [1001, …]'));
        assert.ok(wideOutput.includes('line1000'));
        assert.ok(!wideOutput.includes('line1001'));

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

  it.live('still serves the retained log after the command finishes', () =>
    Effect.gen(function* () {
      const run = yield* launchBackgroundRun((sink) => {
        sink.onStdout?.('compiling\ndone\n');
      });
      yield* Effect.promise(() => run.finish());

      const result = yield* readOutput(run.runId);
      const output = result.output ?? '';

      assert.equal(result.status, 'executed');
      assert.ok(output.includes('compiling'), output);
      assert.ok(output.includes('done'));
      assert.ok(output.includes('[finished'));
      assert.ok(
        !output.includes('no longer available'),
        'A finished-but-resident run must not claim its output was discarded',
      );
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

  it.live(
    'shows one model for a script run in both the listing and its summary',
    () =>
      Effect.gen(function* () {
        const runId = yield* registerScriptRun(
          'model-parity',
          'parity-model-1',
        );

        const summary = yield* ExecutionsTool.call({
          path: `/executions/${runId}`,
        });
        const listing = yield* ExecutionsTool.call({
          path: '/executions',
        });
        const summaryOutput = summary.output ?? '';
        const listingOutput = listing.output ?? '';

        assert.equal(summary.status, 'executed');
        assert.equal(listing.status, 'executed');
        // Both surfaces read the same fold, so neither can disagree about
        // what the run is or what model it routed to.
        assert.ok(listingOutput.includes('parity-model-1'));
        assert.ok(summaryOutput.includes('Model: parity-model-1'));
        assert.ok(summaryOutput.includes('Category: script'));
        assert.ok(listingOutput.includes('script'));
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

  it.live(
    'gives a running process the same category and paths as its completed row',
    () =>
      Effect.gen(function* () {
        const run = yield* launchBackgroundRun((sink) => {
          sink.onStdout?.('still working\n');
        });

        const running = yield* ExecutionsTool.call({
          path: `/executions/${run.runId}`,
        });
        const runningOutput = running.output ?? '';
        assert.equal(running.status, 'executed');
        // The stamped identity, not the live wire's fabricated run mode.
        assert.ok(runningOutput.includes('Category: process'));
        assert.ok(!runningOutput.includes('Category: toolUse'));
        // A shell command routes no model, so the synthetic config's
        // prefaulted one must not reach the summary.
        assert.ok(!runningOutput.includes('Model:'));
        // /output is readable while the process runs, so the running summary
        // must advertise it — the same path the completed row lists.
        assert.ok(
          runningOutput.includes(`/executions/${run.runId}/output`),
          'a running process must advertise its /output path',
        );

        yield* Effect.promise(() => run.finish());

        const completed = yield* ExecutionsTool.call({
          path: `/executions/${run.runId}`,
        });
        const completedOutput = completed.output ?? '';
        assert.ok(completedOutput.includes('Category: process'));
        assert.ok(completedOutput.includes(`/executions/${run.runId}/output`));
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
