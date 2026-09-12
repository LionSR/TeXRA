import '@test/support/defaultSessionTestSetup';

// Test composition imports

// Node imports
import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';

// Third-party imports
import { Effect } from 'effect';
import { beforeEach, afterEach, describe, vi } from 'vitest';

// Local imports
import { getRunRecords, registerRun } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecResult,
  RunIdSchema,
  type RunId,
  type WorkflowRunSnapshot,
  AgentCategory,
} from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { BashTool } from '@tools/bash';
import { generateRunId } from '@utils/core';
import * as execUtils from '@utils/system/execUtils';

function writeWorkflowRunSnapshot(
  session: ReturnType<typeof defaultSession>,
  runId: RunId,
  workflow: WorkflowRunSnapshot,
) {
  return session.commit([
    {
      type: 'run.workflow',
      aggregateId: aggregateId('run', runId),
      workflow,
    },
  ]);
}

// Local file imports
import {
  createRecordingHost,
  recordSessionEvents,
} from '../agent/progressTestUtils';

const PARENT_RUN_ID = RunIdSchema.parse('ba5e00000001');

type ExecChunkSink = Pick<
  Parameters<typeof execUtils.executeCommand>[1] & object,
  'onStdout' | 'onStderr'
>;

interface BackgroundRun {
  readonly runId: RunId;
  /** Settle the mocked process and wait for its completion follow-up. */
  readonly finish: () => Promise<void>;
}

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
      async (_command, options = {}) => {
        emit(options);
        emitted();
        return processExit;
      },
    );
    const followUp = vi
      .spyOn(toolUseFollowUp, 'submitFollowUp')
      .mockReturnValue(Effect.succeed({ status: 'sent' }));

    const { host } = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession());
    publishTestRunStart(defaultSession(), PARENT_RUN_ID);
    const launched = yield* new BashTool()
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
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      );

    assert.equal(launched.status, 'executed');
    yield* Effect.promise(() => outputEmitted);
    yield* Effect.promise(() => defaultSession().settlePublications());
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
    yield* Effect.promise(() => defaultSession().settlePublications());
    return yield* new ExecutionsTool().call({
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
      defaultSession(),
      runId,
      AgentConfigSchema.parse({
        agent: 'bash',
        instruction,
        agentCategory: AgentCategory.ToolUse,
      }),
      'bash',
      { identity: { kind: 'process', tool: 'bash' } },
    );
    return runId;
  });
}

/** Register a multi-agent-workflow run and return its id. */
function registerWorkflowRun(name: string, model?: string) {
  return Effect.gen(function* () {
    const runId = generateRunId();
    yield* registerRun(
      defaultSession(),
      runId,
      {
        name,
        instruction: `Workflow script ${name}`,
        ...(model ? { model } : {}),
      },
      name,
      { identity: { kind: 'multiAgentWorkflow', workflowName: name } },
    );
    return runId;
  });
}

describe('ExecutionsTool /executions/{id}/output', () => {
  setupPlatform({
    workspacePath: '/workspace',
    config: { 'texra.toolUse.requireBashApproval': false },
  });

  beforeEach(() => {
    createProcessSession();
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
              session: defaultSession(),
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
              session: defaultSession(),
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
              session: defaultSession(),
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
              session: defaultSession(),
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
      const session = defaultSession();
      let seqNo = 0;
      const append = (
        id: string,
        text: string,
        level:
          typeof LOG_LEVELS.INFO | typeof LOG_LEVELS.WARN = LOG_LEVELS.INFO,
      ): void => {
        session.publish([
          {
            type: 'transcript.entry',
            aggregateId: aggregateId('run', runId),
            entry: {
              seqNo: ++seqNo,
              id,
              type: STREAM_LOG_ENTRY_TYPES.LOG,
              level,
              messageType: MESSAGE_TYPES.DEFAULT,
              timestamp: Date.now(),
              text,
            },
          },
        ]);
      };
      append('legacy-one', 'legacy one');
      append('legacy-two', 'legacy two');
      append(
        'legacy-warning',
        'legacy warning\r\n\rlegacy tail\r',
        LOG_LEVELS.WARN,
      );

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
            session: defaultSession(),
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
            session: defaultSession(),
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
              session: defaultSession(),
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
            session: defaultSession(),
            runId: PARENT_RUN_ID,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live('points at /report when a registered process has no output yet', () =>
    Effect.gen(function* () {
      const runId = yield* registerProcessRun('sleep 1');

      const result = yield* readOutput(runId);

      assert.equal(result.status, 'executed');
      const output = result.output ?? '';
      assert.ok(output.includes('0 retained transcript chars'));
      assert.ok(output.includes(`/executions/${runId}/report`));
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: PARENT_RUN_ID,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live(
    'points a non-process run at /conversation instead of dumping its transcript',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        yield* registerRun(
          defaultSession(),
          runId,
          AgentConfigSchema.parse({
            agent: 'chat',
            instruction: 'Check the proof.',
            agentCategory: AgentCategory.ToolUse,
          }),
          'chat',
          { identity: { kind: 'agent', agent: 'chat' } },
        );

        const result = yield* readOutput(runId);

        assert.equal(result.status, 'executed');
        assert.ok(
          (result.output ?? '').includes(`/executions/${runId}/conversation`),
        );
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'exposes the canonical workflow aggregate without full instructions',
    () =>
      Effect.gen(function* () {
        const runId = yield* registerWorkflowRun('observable');
        const timestamp = new Date().toISOString();
        const longStageId = `stage-${'s'.repeat(2_500)}-stage-tail`;
        const longCallId = `call-${'i'.repeat(2_500)}-call-tail`;
        const longTitle = `Draft ${'t'.repeat(3_000)}-title-tail`;
        const longError = `Failure ${'e'.repeat(4_000)}-error-tail`;
        const longFiles = Array.from(
          { length: 513 },
          (_, index) => `${'f'.repeat(600)}-${index}-file-tail.tex`,
        );
        yield* writeWorkflowRunSnapshot(defaultSession(), runId, {
          lifecycle: 'active',
          currentStageId: longStageId,
          stages: [
            {
              id: longStageId,
              title: longTitle,
              order: 0,
              lifecycle: 'active',
              startedAt: timestamp,
            },
          ],
          calls: [
            {
              id: longCallId,
              label: '   ',
              stageId: longStageId,
              kind: 'document',
              agent: 'writer',
              files: { input: longFiles, context: [], media: [] },
              childRunId: 'abcdef123456' as RunId,
              attempts: [
                {
                  number: 1,
                  id: '111111111111' as RunId,
                  startedAt: timestamp,
                  completedAt: timestamp,
                },
                {
                  number: 2,
                  id: '222222222222' as RunId,
                  model: 'historical-model',
                  costUsd: 0.2,
                  startedAt: timestamp,
                  completedAt: timestamp,
                },
                {
                  number: 3,
                  id: 'abcdef123456' as RunId,
                  model: 'replacement-model',
                  costUsd: 0.3,
                  startedAt: timestamp,
                  completedAt: timestamp,
                },
              ],
              status: 'failed',
              error: longError,
              timestamps: {
                createdAt: timestamp,
                startedAt: timestamp,
                updatedAt: timestamp,
                completedAt: timestamp,
              },
            },
          ],
          timestamps: { createdAt: timestamp, updatedAt: timestamp },
        });

        const result = yield* new ExecutionsTool().call({
          path: `/executions/${runId}`,
        });
        const output = result.output ?? '';
        assert.equal(result.status, 'executed');
        assert.ok(output.includes('"currentPhase"'));
        assert.ok(output.includes('"calls"'));
        assert.ok(output.includes('"declared": 0'));
        assert.ok(output.includes('"childRunId": "abcdef123456"'));
        assert.ok(output.includes('"number": 3'));
        assert.ok(output.includes('"id": "222222222222"'));
        assert.ok(output.includes('"model": "historical-model"'));
        assert.ok(output.includes('"costUsd": 0.2'));
        assert.ok(output.includes('"error": "Failure '));
        assert.ok(!output.includes('"number": 1'));
        assert.ok(!output.includes('private full instruction'));
        assert.ok(!output.includes('stage-tail'));
        assert.ok(!output.includes('call-tail'));
        assert.ok(!output.includes('title-tail'));
        assert.ok(!output.includes('error-tail'));
        assert.ok(!output.includes('file-tail'));
        assert.ok(output.length < 20_000);
        assert.ok(yield* getRunRecords(defaultSession(), runId).readWorkflow());
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'keeps cancellation reasons on the aggregate and omits per-call error',
    () =>
      Effect.gen(function* () {
        const runId = yield* registerWorkflowRun('cancelled-summary');
        const timestamp = new Date().toISOString();
        yield* writeWorkflowRunSnapshot(defaultSession(), runId, {
          lifecycle: 'cancelled',
          stages: [],
          calls: [
            {
              id: 'cancelled-call',
              label: 'Cancelled call',
              kind: 'document',
              files: { input: [], context: [], media: [] },
              attempts: [],
              status: 'cancelled',
              timestamps: {
                createdAt: timestamp,
                updatedAt: timestamp,
                completedAt: timestamp,
              },
            },
          ],
          error: 'Workflow cancelled by user.',
          timestamps: {
            createdAt: timestamp,
            updatedAt: timestamp,
            completedAt: timestamp,
          },
        });

        const result = yield* new ExecutionsTool().call({
          path: `/executions/${runId}`,
        });
        const output = result.output ?? '';

        assert.equal(result.status, 'executed');
        assert.ok(output.includes('"error": "Workflow cancelled by user."'));
        assert.ok(output.includes('"status": "cancelled"'));
        assert.equal(output.match(/"error":/g)?.length, 1);
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'keeps a failed call ahead of newer completed current-stage calls when bounded',
    () =>
      Effect.gen(function* () {
        const runId = yield* registerWorkflowRun('failed-rank');
        const base = Date.parse('2026-04-01T00:00:00.000Z');
        const completedCalls = Array.from({ length: 8 }, (_, index) => {
          const updatedAt = new Date(base + (index + 1) * 1_000).toISOString();
          return {
            id: `completed-${index}`,
            label: `Completed ${index}`,
            stageId: 'stage-2',
            kind: 'document' as const,
            files: { input: [], context: [], media: [] },
            attempts: [],
            status: 'completed' as const,
            timestamps: {
              createdAt: updatedAt,
              updatedAt,
              completedAt: updatedAt,
            },
          };
        });
        const failedAt = new Date(base).toISOString();
        yield* writeWorkflowRunSnapshot(defaultSession(), runId, {
          lifecycle: 'active',
          currentStageId: 'stage-2',
          stages: [
            {
              id: 'stage-1',
              title: 'Earlier stage',
              order: 0,
              lifecycle: 'failed',
              startedAt: failedAt,
              completedAt: failedAt,
            },
            {
              id: 'stage-2',
              title: 'Current stage',
              order: 1,
              lifecycle: 'active',
              startedAt: failedAt,
            },
          ],
          calls: [
            {
              id: 'older-failed',
              label: 'Older failed',
              stageId: 'stage-1',
              kind: 'document',
              files: { input: [], context: [], media: [] },
              attempts: [
                {
                  number: 1,
                  startedAt: failedAt,
                  completedAt: failedAt,
                },
              ],
              status: 'failed',
              error: 'expected failure',
              timestamps: {
                createdAt: failedAt,
                startedAt: failedAt,
                updatedAt: failedAt,
                completedAt: failedAt,
              },
            },
            ...completedCalls,
          ],
          timestamps: { createdAt: failedAt, updatedAt: failedAt },
        });

        const result = yield* new ExecutionsTool().call({
          path: `/executions/${runId}`,
        });
        const output = result.output ?? '';

        assert.equal(result.status, 'executed');
        assert.ok(output.includes('"id": "older-failed"'));
        assert.ok(output.includes('"omittedCalls": 1'));
        assert.ok(!output.includes('"id": "completed-0"'));
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'keeps an earlier-stage live call ahead of current-stage terminal calls when bounded',
    () =>
      Effect.gen(function* () {
        const runId = yield* registerWorkflowRun('ranked');
        const timestamp = new Date().toISOString();
        const terminalCalls = Array.from({ length: 8 }, (_, index) => ({
          id: `current-terminal-${index}`,
          label: `Current terminal ${index}`,
          stageId: 'stage-2',
          kind: 'document' as const,
          files: { input: [], context: [], media: [] },
          attempts: [],
          status: 'completed' as const,
          timestamps: {
            createdAt: timestamp,
            updatedAt: timestamp,
            completedAt: timestamp,
          },
        }));
        yield* writeWorkflowRunSnapshot(defaultSession(), runId, {
          lifecycle: 'active',
          currentStageId: 'stage-2',
          stages: [
            {
              id: 'stage-1',
              title: 'Earlier stage',
              order: 0,
              lifecycle: 'completed',
              startedAt: timestamp,
              completedAt: timestamp,
            },
            {
              id: 'stage-2',
              title: 'Current stage',
              order: 1,
              lifecycle: 'active',
              startedAt: timestamp,
            },
          ],
          calls: [
            ...terminalCalls,
            {
              id: 'earlier-live',
              label: 'Earlier live',
              stageId: 'stage-1',
              kind: 'document',
              files: { input: [], context: [], media: [] },
              attempts: [{ number: 1, startedAt: timestamp }],
              status: 'running',
              timestamps: {
                createdAt: timestamp,
                startedAt: timestamp,
                updatedAt: timestamp,
              },
            },
          ],
          timestamps: { createdAt: timestamp, updatedAt: timestamp },
        });

        const result = yield* new ExecutionsTool().call({
          path: `/executions/${runId}`,
        });
        const output = result.output ?? '';

        assert.equal(result.status, 'executed');
        assert.ok(output.includes('"id": "earlier-live"'));
        assert.ok(output.includes('"omittedCalls": 1'));
        assert.ok(!output.includes('"id": "current-terminal-7"'));
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'shows one model for a workflow run in both the listing and its summary',
    () =>
      Effect.gen(function* () {
        const runId = yield* registerWorkflowRun(
          'model-parity',
          'parity-model-1',
        );

        const summary = yield* new ExecutionsTool().call({
          path: `/executions/${runId}`,
        });
        const listing = yield* new ExecutionsTool().call({
          path: '/executions',
        });
        const summaryOutput = summary.output ?? '';
        const listingOutput = listing.output ?? '';

        assert.equal(summary.status, 'executed');
        assert.equal(listing.status, 'executed');
        // One model rule: the record's model is real, so both surfaces show it.
        assert.ok(listingOutput.includes('parity-model-1'));
        assert.ok(summaryOutput.includes('Model: parity-model-1'));
        assert.ok(summaryOutput.includes('Category: multiAgentWorkflow'));
        assert.ok(listingOutput.includes('multiAgentWorkflow'));
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
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

        const running = yield* new ExecutionsTool().call({
          path: `/executions/${run.runId}`,
        });
        const runningOutput = running.output ?? '';
        assert.equal(running.status, 'executed');
        // The stamped identity, not the live wire's fabricated run mode.
        assert.ok(runningOutput.includes('Category: process'));
        assert.ok(!runningOutput.includes('Category: toolUse'));
        // /output is readable while the process runs, so the running summary
        // must advertise it — the same path the completed row lists.
        assert.ok(
          runningOutput.includes(`/executions/${run.runId}/output`),
          'a running process must advertise its /output path',
        );

        yield* Effect.promise(() => run.finish());

        const completed = yield* new ExecutionsTool().call({
          path: `/executions/${run.runId}`,
        });
        const completedOutput = completed.output ?? '';
        assert.ok(completedOutput.includes('Category: process'));
        assert.ok(completedOutput.includes(`/executions/${run.runId}/output`));
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: PARENT_RUN_ID,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live('errors on an unknown run id', () =>
    Effect.gen(function* () {
      const result = yield* readOutput(generateRunId());

      assert.equal(result.status, 'error');
      assert.ok((result.error ?? '').includes('Run not found'));
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: PARENT_RUN_ID,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
