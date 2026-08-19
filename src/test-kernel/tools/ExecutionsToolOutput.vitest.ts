// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { afterEach, describe, it, vi } from 'vitest';

// Local imports
import {
  getExecutionStore,
  registerExecution,
  writeWorkflowExecutionSnapshot,
} from '@agent/storage';
import { captureOwnedExecutionLease } from '@agent/storage/executionLease';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import * as toolUseFollowUp from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecResult,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { withToolEnvironment } from '@test/support/toolEnvironment';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { BashTool } from '@tools/bash';
import { generateExecutionId } from '@utils/core';
import * as execUtils from '@utils/system/execUtils';

// Local file imports
import {
  createRecordingHost,
  recordSessionEvents,
} from '../agent/progressTestUtils';

const PARENT_STREAM_ID = 'executions-output-parent' as StreamTabId;

type ExecChunkSink = Pick<
  Parameters<typeof execUtils.executeCommand>[1] & object,
  'onStdout' | 'onStderr'
>;

interface BackgroundRun {
  readonly executionId: string;
  /** Settle the mocked process and wait for its completion follow-up. */
  readonly finish: () => Promise<void>;
}

/**
 * Launch a real background `bash` run whose mocked process emits `chunks`
 * synchronously and then stays open until `finish()` — the only way to
 * observe a mid-run read of the child stream's transcript log.
 */
async function launchBackgroundRun(
  emit: (sink: ExecChunkSink) => void,
): Promise<BackgroundRun> {
  let release!: (result: ExecResult) => void;
  const processExit = new Promise<ExecResult>((resolve) => {
    release = resolve;
  });

  vi.spyOn(execUtils, 'executeCommand').mockImplementation(
    async (_command, options = {}) => {
      emit(options);
      return processExit;
    },
  );
  const followUp = vi
    .spyOn(toolUseFollowUp, 'submitFollowUp')
    .mockResolvedValue({ status: 'sent' });

  const { host } = createRecordingHost();
  const recorded = recordSessionEvents(defaultSession().events);
  let launched;
  try {
    launched = await withToolEnvironment(
      {
        run: { streamId: PARENT_STREAM_ID, session: defaultSession() },
        call: { tracker: new FileInteractionState() },
      },
      () =>
        new BashTool().call({
          command: 'make build',
          run_in_background: true,
        }),
    );
  } finally {
    recorded.detach();
  }

  assert.equal(launched.status, 'executed');
  const executionId = /Execution ID: (\S+)/.exec(launched.output ?? '')?.[1];
  assert.ok(executionId, 'Background launch should report its execution ID');

  return {
    executionId,
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
}

function readOutput(
  executionId: string,
  viewRange?: [number, number],
): Promise<{ status: string; output?: string; error?: string }> {
  return new ExecutionsTool().call({
    path: `/executions/${executionId}/output`,
    ...(viewRange ? { view_range: viewRange } : {}),
  });
}

/** Register a process-identity bash execution and return its stream id. */
async function registerProcessExecution(
  instruction: string,
): Promise<{ executionId: string; streamId: StreamTabId }> {
  const executionId = generateExecutionId();
  const streamId = `bash@tool#${executionId}` as StreamTabId;
  await registerExecution(
    executionId,
    AgentConfigSchema.parse({
      agent: 'bash',
      instruction,
      agentCategory: AgentCategory.ToolUse,
    }),
    'bash',
    {
      streamId,
      identity: { kind: 'process', tool: 'bash' },
    },
  );
  return { executionId, streamId };
}

/** Register a multi-agent-workflow execution and return its id. */
async function registerWorkflowExecution(
  name: string,
  model?: string,
): Promise<string> {
  const executionId = generateExecutionId();
  await registerExecution(
    executionId,
    {
      name,
      instruction: `Workflow script ${name}`,
      ...(model ? { model } : {}),
    },
    name,
    {
      streamId: `workflow-script#${executionId}` as StreamTabId,
      identity: { kind: 'multiAgentWorkflow', workflowName: name },
    },
  );
  return executionId;
}

describe('ExecutionsTool /executions/{id}/output', () => {
  setupPlatform({
    workspacePath: '/workspace',
    config: { 'texra.toolUse.requireBashApproval': false },
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a running background command output so far, with stderr marked', async () => {
    const run = await launchBackgroundRun((sink) => {
      sink.onStdout?.('[ 42%] Building CXX object src/foo.cc.o\n');
      sink.onStderr?.("warning: unused variable 'x'\n");
      sink.onStdout?.('[ 84%] Building CXX object src/bar.cc.o\n');
    });

    const result = await readOutput(run.executionId);

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

    await run.finish();
  });

  it('keeps final unterminated stdout separate from completion lifecycle output', async () => {
    const run = await launchBackgroundRun((sink) => {
      sink.onStdout?.('tail without newline');
    });
    await run.finish();

    const result = await readOutput(run.executionId);
    const output = result.output ?? '';

    assert.ok(output.includes('tail without newline\nTurn completed in '));
    assert.ok(!output.includes('tail without newlineTurn completed in '));
  });

  it('joins chunks that split a line and pages the projection with view_range', async () => {
    const run = await launchBackgroundRun((sink) => {
      // A single logical line delivered across two stdout chunks.
      sink.onStdout?.('line1\nline2\nli');
      sink.onStdout?.('ne3\nline4\nline5\n');
    });

    const full = await readOutput(run.executionId);
    assert.ok(
      (full.output ?? '').includes('line3'),
      'A line split across chunks must be rejoined, not broken in two',
    );

    const paged = await readOutput(run.executionId, [2, 3]);
    const output = paged.output ?? '';
    assert.equal(paged.status, 'executed');
    assert.ok(output.includes('Showing lines 2-3 of 5.'));
    assert.ok(output.includes('line2'));
    assert.ok(output.includes('line3'));
    assert.ok(!output.includes('line1'));
    assert.ok(!output.includes('line4'));

    const past = await readOutput(run.executionId, [900, 950]);
    assert.equal(past.status, 'executed');
    assert.ok((past.output ?? '').includes('No lines in the requested range'));

    await run.finish();
  });

  it('reconstructs split chunks, flushes source switches, and normalizes line breaks', async () => {
    const run = await launchBackgroundRun((sink) => {
      sink.onStdout?.('complete\r');
      sink.onStdout?.('\n\npartial\r');
      sink.onStderr?.('warn');
      sink.onStderr?.('ing\r');
      sink.onStderr?.('\n\nlast err\r');
      sink.onStdout?.('tail');
    });

    const result = await readOutput(run.executionId);
    const output = result.output ?? '';

    assert.ok(output.includes('Showing lines 1-7 of 7.'));
    assert.ok(
      output.includes(
        'complete\n\npartial\nerr: warning\nerr: \nerr: last err\ntail',
      ),
    );
    assert.ok(!output.includes('\r'));
    assert.equal(output.match(/^err: /gm)?.length, 3);

    await run.finish();
  });

  it('renders consecutive untagged legacy rows standalone', async () => {
    const { executionId, streamId } =
      await registerProcessExecution('legacy command');
    const transcripts = defaultSession().transcripts;
    transcripts.ensureStream(streamId);
    const writer = transcripts.acquireWriter(streamId, 'legacy-output-test');
    const append = (
      id: string,
      text: string,
      level: typeof LOG_LEVELS.INFO | typeof LOG_LEVELS.WARN = LOG_LEVELS.INFO,
    ): void => {
      writer.append({
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level,
        messageType: MESSAGE_TYPES.DEFAULT,
        timestamp: Date.now(),
        text,
      });
    };
    append('legacy-one', 'legacy one');
    append('legacy-two', 'legacy two');
    append(
      'legacy-warning',
      'legacy warning\r\n\rlegacy tail\r',
      LOG_LEVELS.WARN,
    );
    writer.close();

    const result = await readOutput(executionId);
    const output = result.output ?? '';

    assert.ok(output.includes('Showing lines 1-5 of 5.'));
    assert.ok(
      output.includes(
        'legacy one\nlegacy two\nerr: legacy warning\nerr: \nerr: legacy tail',
      ),
    );
    assert.ok(!output.includes('legacy onelegacy two'));
    assert.ok(!output.includes('\r'));
  });

  it('treats a carriage-return progress redraw as separate lines', async () => {
    // curl/pip/docker redraw with `\r` and no newline. Splitting on LF alone
    // would make the whole progress bar one enormous line, so the bounded
    // window would still hand back the entire log.
    const run = await launchBackgroundRun((sink) => {
      sink.onStdout?.('  0%\r 50%\r100%\r\ndownload complete\n');
    });

    const result = await readOutput(run.executionId);
    const output = result.output ?? '';

    assert.ok(output.includes('Showing lines 1-4 of 4.'));
    assert.ok(output.includes('  0%'));
    assert.ok(output.includes('download complete'));

    await run.finish();
  });

  it('bounds a chatty log to its tail by default and says how to page back', async () => {
    const lineCount = 1500;
    const run = await launchBackgroundRun((sink) => {
      sink.onStdout?.(
        `${Array.from({ length: lineCount }, (_, i) => `line${i + 1}`).join('\n')}\n`,
      );
    });

    const result = await readOutput(run.executionId);
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
    const wide = await readOutput(run.executionId, [1, lineCount]);
    const wideOutput = wide.output ?? '';
    assert.ok(wideOutput.includes(`Showing lines 1-1000 of ${lineCount}`));
    assert.ok(wideOutput.includes('capped at 1000 lines per read'));
    assert.ok(wideOutput.includes('view_range: [1001, …]'));
    assert.ok(wideOutput.includes('line1000'));
    assert.ok(!wideOutput.includes('line1001'));

    await run.finish();
  });

  it('still serves the retained log after the command finishes', async () => {
    const run = await launchBackgroundRun((sink) => {
      sink.onStdout?.('compiling\ndone\n');
    });
    await run.finish();

    const result = await readOutput(run.executionId);
    const output = result.output ?? '';

    assert.equal(result.status, 'executed');
    assert.ok(output.includes('compiling'));
    assert.ok(output.includes('done'));
    assert.ok(output.includes('[finished'));
    assert.ok(
      !output.includes('no longer available'),
      'A finished-but-resident run must not claim its output was discarded',
    );
  });

  it('points at /report when a process execution has no retained stream log', async () => {
    const { executionId } = await registerProcessExecution('sleep 1');

    const result = await readOutput(executionId);

    assert.equal(result.status, 'executed');
    const output = result.output ?? '';
    assert.ok(output.includes('No retained output'));
    assert.ok(output.includes(`/executions/${executionId}/report`));
  });

  it('points a non-process execution at /conversation instead of dumping its transcript', async () => {
    const executionId = generateExecutionId();
    await registerExecution(
      executionId,
      AgentConfigSchema.parse({
        agent: 'chat',
        instruction: 'Check the proof.',
        agentCategory: AgentCategory.ToolUse,
      }),
      'chat',
      {
        streamId: `chat@model#${executionId}` as StreamTabId,
        identity: { kind: 'agent', agent: 'chat' },
      },
    );

    const result = await readOutput(executionId);

    assert.equal(result.status, 'executed');
    assert.ok(
      (result.output ?? '').includes(`/executions/${executionId}/conversation`),
    );
  });

  it('exposes the canonical workflow aggregate without full instructions', async () => {
    const executionId = await registerWorkflowExecution('observable');
    const timestamp = new Date().toISOString();
    const longStageId = `stage-${'s'.repeat(2_500)}-stage-tail`;
    const longCallId = `call-${'i'.repeat(2_500)}-call-tail`;
    const longTitle = `Draft ${'t'.repeat(3_000)}-title-tail`;
    const longError = `Failure ${'e'.repeat(4_000)}-error-tail`;
    const longFiles = Array.from(
      { length: 513 },
      (_, index) => `${'f'.repeat(600)}-${index}-file-tail.tex`,
    );
    await captureOwnedExecutionLease(executionId)(() =>
      writeWorkflowExecutionSnapshot(executionId, {
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
            agent: 'writer',
            files: { input: longFiles, context: [], media: [] },
            childExecutionId: 'abcdef123456',
            attempts: [
              {
                number: 1,
                id: '111111111111',
                startedAt: timestamp,
                completedAt: timestamp,
              },
              {
                number: 2,
                id: '222222222222',
                childStreamId: 'writer#222222222222',
                model: 'historical-model',
                costUsd: 0.2,
                startedAt: timestamp,
                completedAt: timestamp,
              },
              {
                number: 3,
                id: 'abcdef123456',
                childStreamId: 'writer#abcdef123456',
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
              queuedAt: timestamp,
              startedAt: timestamp,
              updatedAt: timestamp,
              completedAt: timestamp,
            },
          },
        ],
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      }),
    );

    const result = await new ExecutionsTool().call({
      path: `/executions/${executionId}`,
    });
    const output = result.output ?? '';
    assert.equal(result.status, 'executed');
    assert.ok(output.includes('"currentStage"'));
    assert.ok(output.includes('"calls"'));
    assert.ok(output.includes('"stageBlocked": 0'));
    assert.ok(output.includes('"childExecutionId": "abcdef123456"'));
    assert.ok(output.includes('"number": 3'));
    assert.ok(output.includes('"childStreamId": "writer#222222222222"'));
    assert.ok(output.includes('"model": "historical-model"'));
    assert.ok(output.includes('"costUsd": 0.2'));
    assert.ok(!output.includes('"number": 1'));
    assert.ok(!output.includes('private full instruction'));
    assert.ok(!output.includes('stage-tail'));
    assert.ok(!output.includes('call-tail'));
    assert.ok(!output.includes('title-tail'));
    assert.ok(!output.includes('error-tail'));
    assert.ok(!output.includes('file-tail'));
    assert.ok(output.length < 20_000);
    assert.ok((await getExecutionStore(executionId).readMeta())?.workflow);
  });

  it('keeps a failed call ahead of newer completed current-stage calls when bounded', async () => {
    const executionId = await registerWorkflowExecution('failed-rank');
    const base = Date.parse('2026-04-01T00:00:00.000Z');
    const completedCalls = Array.from({ length: 8 }, (_, index) => {
      const updatedAt = new Date(base + (index + 1) * 1_000).toISOString();
      return {
        id: `completed-${index}`,
        label: `Completed ${index}`,
        stageId: 'stage-2',
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
    await captureOwnedExecutionLease(executionId)(() =>
      writeWorkflowExecutionSnapshot(executionId, {
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
      }),
    );

    const result = await new ExecutionsTool().call({
      path: `/executions/${executionId}`,
    });
    const output = result.output ?? '';

    assert.equal(result.status, 'executed');
    assert.ok(output.includes('"id": "older-failed"'));
    assert.ok(output.includes('"omittedCalls": 1'));
    assert.ok(!output.includes('"id": "completed-0"'));
  });

  it('keeps an earlier-stage live call ahead of current-stage terminal calls when bounded', async () => {
    const executionId = await registerWorkflowExecution('ranked');
    const timestamp = new Date().toISOString();
    const terminalCalls = Array.from({ length: 8 }, (_, index) => ({
      id: `current-terminal-${index}`,
      label: `Current terminal ${index}`,
      stageId: 'stage-2',
      files: { input: [], context: [], media: [] },
      attempts: [],
      status: 'completed' as const,
      timestamps: {
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      },
    }));
    await captureOwnedExecutionLease(executionId)(() =>
      writeWorkflowExecutionSnapshot(executionId, {
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
            files: { input: [], context: [], media: [] },
            attempts: [{ number: 1, startedAt: timestamp }],
            status: 'running',
            timestamps: {
              createdAt: timestamp,
              queuedAt: timestamp,
              startedAt: timestamp,
              updatedAt: timestamp,
            },
          },
        ],
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      }),
    );

    const result = await new ExecutionsTool().call({
      path: `/executions/${executionId}`,
    });
    const output = result.output ?? '';

    assert.equal(result.status, 'executed');
    assert.ok(output.includes('"id": "earlier-live"'));
    assert.ok(output.includes('"omittedCalls": 1'));
    assert.ok(!output.includes('"id": "current-terminal-7"'));
  });

  it('shows one model for a workflow run in both the listing and its summary', async () => {
    const executionId = await registerWorkflowExecution(
      'model-parity',
      'parity-model-1',
    );

    const summary = await new ExecutionsTool().call({
      path: `/executions/${executionId}`,
    });
    const listing = await new ExecutionsTool().call({ path: '/executions' });
    const summaryOutput = summary.output ?? '';
    const listingOutput = listing.output ?? '';

    assert.equal(summary.status, 'executed');
    assert.equal(listing.status, 'executed');
    // One model rule: the record's model is real, so both surfaces show it.
    assert.ok(listingOutput.includes('parity-model-1'));
    assert.ok(summaryOutput.includes('Model: parity-model-1'));
    assert.ok(summaryOutput.includes('Category: multiAgentWorkflow'));
    assert.ok(listingOutput.includes('multiAgentWorkflow'));
  });

  it('gives a running process the same category and paths as its completed row', async () => {
    const run = await launchBackgroundRun((sink) => {
      sink.onStdout?.('still working\n');
    });

    const running = await new ExecutionsTool().call({
      path: `/executions/${run.executionId}`,
    });
    const runningOutput = running.output ?? '';
    assert.equal(running.status, 'executed');
    // The stamped identity, not the live wire's fabricated execution mode.
    assert.ok(runningOutput.includes('Category: process'));
    assert.ok(!runningOutput.includes('Category: toolUse'));
    // /output is readable while the process runs, so the running summary
    // must advertise it — the same path the completed row lists.
    assert.ok(
      runningOutput.includes(`/executions/${run.executionId}/output`),
      'a running process must advertise its /output path',
    );

    await run.finish();

    const completed = await new ExecutionsTool().call({
      path: `/executions/${run.executionId}`,
    });
    const completedOutput = completed.output ?? '';
    assert.ok(completedOutput.includes('Category: process'));
    assert.ok(
      completedOutput.includes(`/executions/${run.executionId}/output`),
    );
  });

  it('errors on an unknown execution id', async () => {
    const result = await readOutput(generateExecutionId());

    assert.equal(result.status, 'error');
    assert.ok((result.error ?? '').includes('Execution not found'));
  });
});
