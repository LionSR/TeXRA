import '@test/support/defaultSessionTestSetup';

// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';

// Third-party imports
import pDefer from 'p-defer';
import { Effect, Exit, Fiber, Schedule } from 'effect';
import { beforeEach, afterEach, describe, vi } from 'vitest';

// Local imports
import { getRunRecords } from '@agent/storage';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { formatToolResultAsText } from '@agent/runtime/run/toolResultText';
import {
  RUN_OUTCOME,
  aggregateId,
  RUN_PHASE,
  type ExecResult,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { BashTool } from '@tools/bash';
import * as bashDelivery from '@tools/delegation/bashDelivery';
import { generateRunId } from '@utils/core';
import * as execUtils from '@utils/system/execUtils';

// Local file imports
import { recordSessionEvents } from '../agent/progressTestUtils';

/** The formatter's cap: a result longer than this is truncated head+tail. */
const TOOL_RESULT_TEXT_CAP = 200_000;

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
    async (_command, options = {}) => {
      stream(options);
      return {
        success: true,
        stdout: '',
        stderr: '',
        timedOut: false,
        exitCode: 0,
        ...result,
      };
    },
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
 * Stub `executeCommand` to park on a promise the test resolves manually.
 * Returns the resolver so the case can interleave assertions before the
 * (mocked) process settles.
 */
function holdCommand(): (result: ExecResult) => void {
  const command = pDefer<ExecResult>();
  vi.spyOn(execUtils, 'executeCommand').mockImplementation(
    () => command.promise,
  );
  return command.resolve;
}

/** Shared teardown for background-launch cases. */
function detachBackgroundRun(
  recorded: ReturnType<typeof recordSessionEvents>,
  parentRunId: RunId,
): void {
  defaultSession().followUps.terminalize(parentRunId);
}

/**
 * Park a run WAITING the way its loop does: the `waiting` flow step is the
 * fact the fold reads the phase from, so the delivery path sees the same
 * parked parent a real run would.
 */
async function parkRunWaiting(runId: RunId): Promise<void> {
  const session = defaultSession();
  publishTestRunStart(session, runId);
  session.publish([
    {
      type: 'flow.step',
      aggregateId: aggregateId('run', runId),
      payload: { family: 'toolUse', step: 'waiting' },
    },
  ]);
  await vi.waitFor(() => {
    assert.equal(defaultSession().runView(runId)?.status, RUN_PHASE.WAITING);
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
  publishTestRunStart(defaultSession(), parentRunId);
  return new BashTool()
    .call({
      command: 'make build',
      run_in_background: true,
    })
    .pipe(
      Effect.provide(
        nativeToolTestLayer({
          tracker: new FileInteractionState(),
          run: {
            session: defaultSession(),
            runId: parentRunId,
            toolPolicy: {},
          },
        }),
      ),
    );
}

describe('BashTool', () => {
  setupPlatform(BASH_PLATFORM_OPTIONS);
  beforeEach(() => {
    createProcessSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.live('preserves long stdout for tool results and model payloads', () =>
    Effect.gen(function* () {
      const longOutput = '0123456789'.repeat(35); // 350 chars, exceeds log truncation of 150
      const execResult: ExecResult = {
        success: true,
        // executeCommand trims trailing whitespace before returning stdout
        stdout: `${longOutput}\n`.trim(),
        stderr: '',
        timedOut: false,
        exitCode: 0,
      };

      let receivedSignal: AbortSignal | undefined;
      vi.spyOn(execUtils, 'executeCommand').mockImplementation(
        async (_command, options = {}) => {
          receivedSignal = options.signal;
          return execResult;
        },
      );

      const result = yield* new BashTool().call({ command: 'echo long' }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            tracker: new FileInteractionState(),
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      );
      assert.equal(
        result.output,
        longOutput,
        'Bash tool should return the full stdout text',
      );
      // The lowering every settled call passes through on its way to the model.
      assert.ok(
        formatToolResultAsText(result).includes(longOutput),
        'Model payload should contain the complete stdout text',
      );
      assert.equal(
        receivedSignal instanceof AbortSignal,
        true,
        'Bash command should receive its fiber-owned abort signal',
      );
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live(
    'marks exactly one character elided at 54,001 normalized characters',
    () =>
      Effect.gen(function* () {
        const text = 'h'.repeat(4_000) + 'X' + 't'.repeat(50_000);
        mockStreamingCommand((options) => options.onStdout?.(text));

        const result = yield* new BashTool().call({ command: 'one-elided' });
        assert.equal(
          result.output,
          `${'h'.repeat(4_000)}\n\n[... 1 characters elided from stdout ...]\n\n${'t'.repeat(50_000)}`,
        );
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live.each([
    {
      name: 'leading and trailing whitespace',
      chunks: [' \t\n'.repeat(40_000), '  body', '  ', '\r\n'.repeat(40_000)],
      expected: 'body',
    },
    {
      name: 'all whitespace',
      chunks: [' \t\n'.repeat(40_000), '\r\n'.repeat(40_000)],
      expected: '',
    },
    {
      name: 'internal whitespace',
      chunks: ['  alpha', ' '.repeat(20_000), 'omega  '],
      expected: `alpha${' '.repeat(20_000)}omega`,
    },
  ])('matches full-stream trim for $name', ({ chunks, expected }) =>
    Effect.gen(function* () {
      mockStreamingCommand((options) => {
        for (const chunk of chunks) options.onStdout?.(chunk);
      });

      const result = yield* new BashTool().call({
        command: 'whitespace-output',
      });
      assert.equal(result.output, expected);
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live('counts only normalized internal whitespace as elided', () =>
    Effect.gen(function* () {
      const internalWhitespace = ' '.repeat(60_000);
      mockStreamingCommand((options) => {
        options.onStdout?.(`  A${internalWhitespace}`);
        options.onStdout?.(`B${' '.repeat(100_000)}`);
      });

      const result = yield* new BashTool().call({ command: 'whitespace-gap' });
      const output = String(result.output);
      assert.ok(
        output.includes(
          `[... ${(6_002).toLocaleString()} characters elided from stdout ...]`,
        ),
      );
      assert.ok(output.startsWith(`A${' '.repeat(3_999)}`));
      assert.ok(output.endsWith(`${' '.repeat(49_999)}B`));
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

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

      const result = yield* new BashTool().call({
        command: 'unicode-boundary',
      });
      const output = String(result.output);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(output));
      assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(output));
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live(
    'incrementally retains bounded head and tail stdout across Unicode chunk boundaries',
    () =>
      Effect.gen(function* () {
        const headMarker = 'HEAD🙂';
        const tailMarker = 'TAIL🙂';
        const emoji = '🙂';

        mockStreamingCommand((options) => {
          assert.equal(options.buffer, false);
          options.onStdout?.(`HEAD${emoji[0]}`);
          options.onStdout?.(`${emoji[1]}\n`);
          options.onStdout?.('x'.repeat(100_000));
          options.onStdout?.(`\n${tailMarker}\n`);
        });

        const result = yield* new BashTool().call({ command: 'large-output' });
        assert.equal(result.status, 'executed');
        const output = String(result.output);
        assert.ok(output.startsWith(headMarker));
        assert.ok(output.endsWith(tailMarker));
        assert.match(output, /characters elided from stdout/);
        assert.ok(!output.includes('x'.repeat(60_000)));
        assert.ok(!output.includes('\ufffd'));
        assert.ok(output.length < 55_000);
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'keeps bounded stderr and stdout separate and ordered on large failures',
    () =>
      Effect.gen(function* () {
        mockStreamingCommand(
          (options) => {
            options.onStdout?.('STDOUT_HEAD\n');
            options.onStdout?.('o'.repeat(100_000));
            options.onStdout?.('\nSTDOUT_TAIL');
            options.onStderr?.('STDERR_HEAD\n');
            options.onStderr?.('e'.repeat(100_000));
            options.onStderr?.('\nSTDERR_TAIL');
          },
          { success: false, exitCode: 9 },
        );

        const result = yield* new BashTool().call({ command: 'large-failure' });
        assert.equal(result.status, 'error');
        const error = result.error ?? '';
        assert.ok(error.includes('STDERR_HEAD'));
        assert.ok(error.includes('STDERR_TAIL'));
        assert.ok(error.includes('characters elided from stderr'));
        assert.ok(error.includes('STDOUT_HEAD'));
        assert.ok(error.includes('STDOUT_TAIL'));
        assert.ok(error.includes('characters elided from stdout'));
        assert.ok(error.indexOf('STDERR_HEAD') < error.indexOf('STDOUT_HEAD'));
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'keeps head and tail of an oversized command failure instead of discarding it',
    () =>
      Effect.gen(function* () {
        // Simulates a huge broken latexmk log: engine name up front, error detail
        // at the tail (where LaTeX/build errors cluster), filler in between.
        const hugeStderr =
          'ENGINE_HEADER '.repeat(400) +
          'x'.repeat(TOOL_RESULT_TEXT_CAP) +
          'TAIL_ERROR_DETAIL '.repeat(5000);

        mockStreamingCommand((options) => options.onStderr?.(hugeStderr), {
          success: false,
          exitCode: 1,
        });

        const result = yield* new BashTool().call({
          command: 'latexmk -pdf p.tex',
        });
        assert.equal(result.status, 'error');

        // This is exactly the choke point every model handler funnels through
        // before sending tool output back to the model.
        const text = formatToolResultAsText(result);
        assert.ok(
          text.includes('characters elided'),
          'Oversized result should be elided, not replaced wholesale',
        );
        assert.ok(!text.includes('was not included'));
        assert.ok(text.includes('ENGINE_HEADER'));
        assert.ok(text.includes('TAIL_ERROR_DETAIL'));
        assert.ok(!text.includes('x'.repeat(1000)));
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'preserves the first fatal error and the latest output for an oversized background run',
    () =>
      Effect.gen(function* () {
        // Simulates a multi-minute build whose first line is the fatal compiler
        // error and whose output keeps streaming well past the tail budget
        // (12,000 chars) before finishing — mirroring the scenario in #7145
        // where a long background run's early error was silently dropped once
        // the tail-only buffer rolled past it.
        const headMarker =
          'FATAL: undefined reference to `compute` at build.c:12';
        const tailMarker = 'FATAL: link step failed, aborting build';
        const filler = 'x'.repeat(2000);
        const chunks = [
          `${headMarker}\n`,
          ...Array.from({ length: 8 }, () => filler),
          `${tailMarker}\n`,
        ];

        mockStreamingCommand(
          (options) => {
            for (const chunk of chunks) {
              options.onStdout?.(chunk);
            }
          },
          { success: false, exitCode: 1 },
        );

        const submitFollowUpSpy = vi
          .spyOn(toolUseFollowUp, 'submitFollowUp')
          .mockReturnValue(Effect.succeed({ status: 'sent' }));

        const parentRunId = generateRunId();
        const parentLease = defaultSession().followUps.claimLive(
          parentRunId,
          'flow',
        )!;
        const recorded = recordSessionEvents(defaultSession());

        try {
          const launchResult = yield* launchBackgroundBash(parentRunId);
          assert.equal(launchResult.status, 'executed');

          // The background run delivers its result asynchronously as a follow-up
          // once the (mocked) process settles.
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              assert.ok(
                submitFollowUpSpy.mock.calls.length > 0,
                'Background bash should deliver a follow-up once the run completes',
              );
            }),
          );
        } finally {
          defaultSession().followUps.release(parentLease, 'terminal');
        }

        const followUpArg = submitFollowUpSpy.mock.calls[0]?.[1];
        const deliveredText =
          typeof followUpArg === 'string' ? followUpArg : followUpArg?.text;
        assert.ok(
          typeof deliveredText === 'string' &&
            deliveredText.includes(headMarker),
          'Delivered follow-up should retain the first fatal error (head)',
        );
        assert.ok(
          typeof deliveredText === 'string' &&
            deliveredText.includes(tailMarker),
          'Delivered follow-up should retain the most recent output (tail)',
        );
        assert.match(
          deliveredText ?? '',
          /<output-elided>[\d,]+ characters elided<\/output-elided>/,
          'Delivered follow-up should note how many characters sit between head and tail',
        );
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'wakes a WAITING parent run when a background bash run completes',
    () =>
      Effect.gen(function* () {
        // Regression: background bash delivery used a bespoke sendFollowUp call
        // with no wake step, so a parent suspended WAITING on the job never
        // resumed — every other child-run type routes through the shared
        // wake-aware submitFollowUp path. Prove the wake actually fires
        // by asserting the host resume port gets invoked once the run completes.
        vi.spyOn(execUtils, 'executeCommand').mockResolvedValue(
          DONE_EXEC_RESULT,
        );

        const parentRunId = generateRunId();
        const tryResumeRun = vi.fn().mockResolvedValue(true);
        yield* Effect.promise(() =>
          installPlatform(BASH_PLATFORM_OPTIONS, {
            agentResume: { tryResumeRun },
          }),
        );
        yield* Effect.promise(() => parkRunWaiting(parentRunId));

        const recorded = recordSessionEvents(defaultSession());

        try {
          const launchResult = yield* launchBackgroundBash(parentRunId);
          assert.equal(launchResult.status, 'executed');

          // The background run's completion must queue the follow-up AND wake
          // the WAITING parent through the host resume port — not just queue it
          // for the parent to notice on its own.
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              assert.ok(
                tryResumeRun.mock.calls.length > 0,
                'Background bash completion should wake the WAITING parent run',
              );
            }),
          );
          assert.equal(tryResumeRun.mock.calls[0]?.[0], parentRunId);
        } finally {
          detachBackgroundRun(recorded, parentRunId);
        }
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
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
        // Regression: waking a WAITING parent (`agentResume.tryResumeRun`) can
        // await the ENTIRE resumed parent turn. If that wake were awaited before
        // this run's own finalize (as it used to be, delivering via a
        // single wake-aware call before `finalizeBackground`), a resumed parent
        // that immediately calls `executions` with action=wait on this same
        // run could find it still RUNNING and block on itself for the
        // whole wait budget. Prove the ordering: hold the host resume port open
        // and confirm the run is already untracked (terminal) by the time
        // that port is even invoked.
        vi.spyOn(execUtils, 'executeCommand').mockResolvedValue(
          DONE_EXEC_RESULT,
        );

        const parentRunId = generateRunId();
        let releaseResume: (() => void) | undefined;
        let handleAtResumeTime: unknown;
        let runId = '' as RunId;
        const tryResumeRun = vi.fn().mockImplementation(async () => {
          handleAtResumeTime = defaultSession().runs.getHandle(runId);
          await new Promise<void>((resolve) => {
            releaseResume = resolve;
          });
          return true;
        });
        yield* Effect.promise(() =>
          installPlatform(BASH_PLATFORM_OPTIONS, {
            agentResume: { tryResumeRun },
          }),
        );
        yield* Effect.promise(() => parkRunWaiting(parentRunId));

        const recorded = recordSessionEvents(defaultSession());

        try {
          const launchResult = yield* launchBackgroundBash(parentRunId);
          assert.equal(launchResult.status, 'executed');
          const launched = launchedIds(launchResult);
          assert.ok(launched.runId, 'Launch output should report a run id');
          runId = launched.runId;

          yield* Effect.promise(() =>
            vi.waitFor(() => {
              assert.ok(
                tryResumeRun.mock.calls.length > 0,
                'Background bash completion should reach the wake step',
              );
            }),
          );
          // The wake step was reached — this run must already be untracked
          // (finalized), never still RUNNING, so a resumed parent that waits on
          // it right now resolves immediately instead of racing its own wake.
          assert.equal(handleAtResumeTime, undefined);
          assert.equal(defaultSession().runs.getHandle(runId), undefined);
        } finally {
          releaseResume?.();
          detachBackgroundRun(recorded, parentRunId);
        }
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'fails background run when its result metadata cannot be persisted',
    () =>
      Effect.gen(function* () {
        const resolveCommand = holdCommand();
        yield* Effect.promise(() => installPlatform(BASH_PLATFORM_OPTIONS));
        const parentRunId = generateRunId();
        const recorded = recordSessionEvents(defaultSession());

        const launchResult = yield* launchBackgroundBash(parentRunId);
        const { runId } = launchedIds(launchResult);
        assert.ok(runId, JSON.stringify(launchResult));
        const session = defaultSession();
        const commit = session.commit.bind(session);
        vi.spyOn(session, 'commit').mockImplementation((events) =>
          events.some((event) => event.type === 'run.result')
            ? Effect.die(new Error('result metadata disk full'))
            : commit(events),
        );
        const records = getRunRecords(session, runId);

        resolveCommand(DONE_EXEC_RESULT);

        // The manifest is what `/result` reads, so its loss is the run's failure
        // rather than a completed run with a silently missing result.
        yield* records.readRunEnd().pipe(
          Effect.repeat({
            while: (end) => end?.outcome !== RUN_OUTCOME.FAILED,
            schedule: Schedule.spaced('10 millis'),
          }),
          Effect.timeout('1 second'),
        );
        detachBackgroundRun(recorded, parentRunId);
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'finalizes the background child when the completion path throws before its normal finalize',
    () =>
      Effect.gen(function* () {
        // Nothing else finalizes a background child: before the latch, an
        // unexpected throw on the completion path left the child run RUNNING
        // forever, with its interrupt handler still attached to a dead process.
        const resolveCommand = holdCommand();
        vi.spyOn(bashDelivery, 'formatBashDelivery').mockImplementation(() => {
          throw new Error('delivery formatting blew up');
        });
        yield* Effect.promise(() => installPlatform(BASH_PLATFORM_OPTIONS));
        const parentRunId = generateRunId();
        const recorded = recordSessionEvents(defaultSession());

        const launchResult = yield* launchBackgroundBash(parentRunId);
        const { output, runId } = launchedIds(launchResult);
        assert.ok(runId, output);

        resolveCommand(DONE_EXEC_RESULT);

        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            assert.equal(
              (await recorded.read()).some(
                (event) =>
                  event.type === 'run.end' &&
                  event.aggregateId === aggregateId('run', runId) &&
                  event.outcome === RUN_OUTCOME.FAILED,
              ),
              true,
            );
          }),
        );
        assert.equal(defaultSession().runs.getHandle(runId), undefined);

        detachBackgroundRun(recorded, parentRunId);
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
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
        const parentRunId = generateRunId();
        const recorded = recordSessionEvents(defaultSession());

        const launchResult = yield* launchBackgroundBash(parentRunId);
        const { output, runId } = launchedIds(launchResult);
        assert.ok(runId, output);

        // The user stop lands CANCELLED on the run phase; only afterwards does
        // the killed process report its non-zero exit.
        const stopped = defaultSession().runs.kill(runId);
        assert.equal(stopped.accepted, true);
        const stopSettlement = yield* Effect.forkChild(stopped.settlement);
        resolveCommand({
          success: false,
          stdout: '',
          stderr: 'Terminated\n',
          timedOut: false,
          exitCode: 143,
        });

        yield* Fiber.join(stopSettlement);
        const records = getRunRecords(defaultSession(), runId);
        yield* records.readRunEnd().pipe(
          Effect.repeat({
            while: (end) => end?.outcome !== RUN_OUTCOME.CANCELLED,
            schedule: Schedule.spaced('10 millis'),
          }),
          Effect.timeout('1 second'),
        );
        detachBackgroundRun(recorded, parentRunId);
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live('keeps bounded streamed stdout and stderr in timeout feedback', () =>
    Effect.gen(function* () {
      mockStreamingCommand(
        (options) => {
          options.onStdout?.(`STDOUT_HEAD${'o'.repeat(100_000)}STDOUT_TAIL`);
          options.onStderr?.(`STDERR_HEAD${'e'.repeat(100_000)}STDERR_TAIL`);
        },
        { success: false, timedOut: true, exitCode: 1 },
      );

      const result = yield* new BashTool().call({
        command: 'slow-command',
        timeout: 1_000,
      });
      assert.equal(result.status, 'error');
      const error = result.error ?? '';
      assert.ok(error.startsWith('Foreground command timed out after 1s.'));
      assert.match(
        error,
        /<stdout>STDOUT_HEAD[\s\S]*characters elided from stdout[\s\S]*STDOUT_TAIL<\/stdout>/,
      );
      assert.match(
        error,
        /<stderr>STDERR_HEAD[\s\S]*characters elided from stderr[\s\S]*STDERR_TAIL<\/stderr>/,
      );
      assert.ok(error.includes('run_in_background: true'));
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live(
    'opens its deferred card before output and interrupts the command with its fiber',
    () =>
      Effect.gen(function* () {
        const started = pDefer<void>();
        let receivedSignal: AbortSignal | undefined;
        vi.spyOn(execUtils, 'executeCommand').mockImplementation(
          (_command, options = {}) => {
            receivedSignal = options.signal;
            options.onStdout?.('started\n');
            started.resolve();
            return new Promise<ExecResult>((resolve) => {
              options.signal?.addEventListener(
                'abort',
                () =>
                  resolve({
                    success: false,
                    stdout: '',
                    stderr: 'Command aborted by user',
                    timedOut: false,
                    exitCode: 130,
                  }),
                { once: true },
              );
            });
          },
        );
        const hookCalls: string[] = [];
        const fiber = yield* Effect.forkChild(
          new BashTool().call({ command: 'echo long' }).pipe(
            Effect.provide(
              nativeToolTestLayer({
                tracker: new FileInteractionState(),
                hooks: {
                  onRunReady: () => hookCalls.push('ready'),
                  onToolOutput: (chunk) => hookCalls.push(`output:${chunk}`),
                },
                run: {
                  session: defaultSession(),
                  runId: 'bash-tool' as RunId,
                  toolPolicy: {},
                },
              }),
            ),
          ),
        );
        yield* Effect.promise(() => started.promise);
        assert.deepEqual(hookCalls, ['ready', 'output:started\n']);
        assert.equal(receivedSignal?.aborted, false);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        assert.equal(receivedSignal?.aborted, true);
        assert.equal(Exit.hasInterrupts(exit), true);
      }),
  );
});
