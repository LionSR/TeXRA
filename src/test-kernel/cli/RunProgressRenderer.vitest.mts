import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { pickGlobalArgs } from '@cli/runtime/globalArgs';
import {
  createRunProgressRenderer,
  shouldRenderRunProgress,
} from '@cli/runtime/runProgressRenderer';
import { createCliRuntimeHost } from '@cli/runtime/runtimeHost';
import type { CliContext } from '@cli/runtime/cliContext';
import { STREAM_TRANSITION_CAUSE } from '@common/constants/streamStatus';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
}));

function context(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'never',
    quietLogs: false,
    renderRunProgress: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    colorEnabled: true,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

function workflowTaskState(
  overrides: {
    streamId?: string;
    agent?: string;
    inputFiles?: string[];
  } = {},
) {
  return {
    streamId: overrides.streamId ?? 'stream-1',
    taskState: {
      agentConfig: {
        agent: overrides.agent ?? 'polish',
        agentCategory: AgentCategory.Workflow,
        model: 'deepseekT',
        inputFiles: overrides.inputFiles ?? ['paper.tex'],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: [],
        editedFile: null,
        editedFiles: [],
        toolConfig: {
          autoExtractFigure: false,
          autoExtractTikzFigure: false,
          attachTeXCount: false,
          attachDiagnostics: false,
          autoCompileInputPdf: false,
        },
        memories: [],
        instruction: '',
        workingDirectory: '/tmp/project',
      },
      activeFiles: {
        input: true,
        output: false,
        media: false,
        context: false,
      },
    },
  };
}

function toolUseTaskState(
  overrides: {
    streamId?: string;
    agent?: string;
    inputFiles?: string[];
  } = {},
) {
  return {
    streamId: overrides.streamId ?? 'stream-1',
    taskState: {
      agentConfig: {
        agent: overrides.agent ?? 'polish',
        agentCategory: AgentCategory.ToolUse,
        model: 'deepseekT',
        inputFiles: overrides.inputFiles ?? [],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: [],
        editedFile: null,
        editedFiles: [],
        toolConfig: {
          autoExtractFigure: false,
          autoExtractTikzFigure: false,
          attachTeXCount: false,
          attachDiagnostics: false,
          autoCompileInputPdf: false,
        },
        memories: [],
        instruction: '',
        workingDirectory: '/tmp/project',
      },
    },
  };
}

function emitWorkflowRunConfig(
  events: SessionEventHub,
  taskState = workflowTaskState(),
): void {
  const streamId = taskState.streamId as StreamTabId;
  events.emit({
    scope: 'run',
    streamId,
    event: {
      type: 'run.config',
      streamId,
      executionId: 'execution-1' as ExecutionId,
      config: taskState.taskState.agentConfig,
    },
  });
}

function outputBuffer(): { write: (chunk: string) => void; text: string } {
  const buffer = {
    text: '',
    write: (chunk: string) => {
      buffer.text += chunk;
    },
  };
  return buffer;
}

async function captureStreamWrites(
  stream: NodeJS.WriteStream,
  action: () => Promise<void>,
): Promise<string> {
  let output = '';
  const originalWrite = stream.write;
  stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    output += decodeStreamChunk(chunk, args);
    const callback = args.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === 'function',
    );
    callback?.();
    return true;
  }) as typeof stream.write;

  try {
    await action();
  } finally {
    stream.write = originalWrite;
  }

  return output;
}

function decodeStreamChunk(
  chunk: string | Uint8Array,
  args: unknown[],
): string {
  if (typeof chunk === 'string') return chunk;

  const encoding = args.find(
    (arg): arg is BufferEncoding => typeof arg === 'string',
  );
  return Buffer.from(chunk).toString(encoding);
}

describe('CLI run progress renderer', () => {
  beforeEach(() => {
    mocks.getAgent.mockReset();
  });

  it('renders a single ANSI status line and clears it on close', () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => now,
    });

    expect(renderer).toBeDefined();
    renderer?.handle('setTaskState', workflowTaskState());
    expect(output.text).toBe('\r\x1b[2Kpolish paper.tex · 0s');

    now = 1200;
    renderer?.handle('updateRoundStage', {
      streamId: 'stream-1',
      roundStage: { index: 1 },
    });
    expect(output.text).toContain('\r\x1b[2K[r2] · polish paper.tex · 1s');

    renderer?.clear();
    expect(output.text.endsWith('\r\x1b[2K')).toBe(true);
  });

  it('keeps long elapsed times in minute-second form', () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => now,
    });

    now = 3_600_000;
    renderer?.handle('setTaskState', workflowTaskState());

    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 60m 00s');
  });

  it('ticks the ANSI status line while a root workflow is quiet', () => {
    let now = 0;
    const output = outputBuffer();
    let heartbeat: (() => void) | undefined;
    let clearCount = 0;
    const renderer = createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => now,
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        clearCount += 1;
      }) as typeof clearInterval,
    });

    renderer?.handle('setTaskState', workflowTaskState());

    expect(heartbeat).toBeDefined();
    now = 1000;
    heartbeat?.();
    now = 2300;
    heartbeat?.();

    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 1s');
    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 2s');

    renderer?.handle('updateStreamStatus', {
      streamId: 'stream-1',
      status: STREAM_PHASE.CANCELLED,
      previousStatus: STREAM_PHASE.RUNNING,
    });
    expect(clearCount).toBe(1);
  });

  it('summarizes multi-input workflow progress without hiding extra files', () => {
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        nowMs: () => 0,
      },
    );

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        inputFiles: ['number-theory.tex', 'algebra.tex'],
      }),
    );

    expect(output.text).toBe('polish number-theory.tex +1 · 0s\n');
  });

  it('shows planned workflow rounds before the first model turn', () => {
    mocks.getAgent.mockReturnValue({
      rounds: 2,
    });
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        minIntervalMs: 0,
        nowMs: () => 0,
      },
    );

    renderer?.handle('setTaskState', workflowTaskState());
    renderer?.handle('updateRoundStage', {
      streamId: 'stream-1',
      roundStage: { index: 0 },
    });

    expect(mocks.getAgent).toHaveBeenCalledWith(
      'polish',
      AgentCategory.Workflow,
    );
    expect(output.text).toBe(
      'polish paper.tex · 2 rounds · 0s\n' + '[r1/2] · polish paper.tex · 0s\n',
    );
  });

  it('does not add workflow round hints to tool-use progress', () => {
    mocks.getAgent.mockReturnValue({
      rounds: 2,
    });
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        nowMs: () => 0,
      },
    );

    renderer?.handle(
      'setTaskState',
      toolUseTaskState({
        inputFiles: [],
      }),
    );

    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(output.text).toBe('polish · 0s\n');
  });

  it('prints phase changes on separate lines when ANSI is disabled', () => {
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        nowMs: () => 0,
      },
    );

    renderer?.handle('setTaskState', workflowTaskState());
    renderer?.handle('updateStreamDescription', {
      streamId: 'stream-1',
      description: 'drafting',
    });
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'stream-1',
      processes: [
        {
          executionId: 'process-1',
          agentName: 'bash',
          toolName: 'Bash',
          status: 'running',
        },
      ],
    });

    expect(output.text).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · drafting · 0s\n' +
        'polish paper.tex · drafting · tool: Bash · 0s\n',
    );
  });

  it('renders the live line from direct session and run facts', () => {
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        minIntervalMs: 0,
        nowMs: () => 0,
      },
    );
    const streamId = 'stream-1' as StreamTabId;
    const taskState = workflowTaskState();

    renderer?.handleSessionEvent({
      scope: 'run',
      streamId,
      event: {
        type: 'run.config',
        streamId,
        executionId: 'execution-1' as ExecutionId,
        config: taskState.taskState.agentConfig,
      },
    });
    renderer?.handleSessionEvent({
      scope: 'run',
      streamId,
      event: {
        type: 'conversation.progress',
        progress: { toolCallCount: 3 },
      },
    });
    renderer?.handleSessionEvent({
      scope: 'run',
      streamId,
      event: {
        type: 'stage.start',
        id: 'round-1',
        label: 'Round 1',
        kind: 'round',
        index: 0,
        total: 2,
      },
    });
    renderer?.handleSessionEvent({
      scope: 'session',
      event: {
        type: 'updateStreamDescription',
        payload: { streamId, description: 'drafting' },
      },
    });
    renderer?.handleSessionEvent({
      scope: 'run',
      streamId,
      event: {
        type: 'child.activity',
        kind: 'subagents',
        parentStreamId: streamId,
        children: [
          {
            kind: 'subagent',
            executionId: 'child-1',
            childStreamId: 'child-stream',
            agentName: 'review',
            status: 'running',
          },
        ],
      },
    });
    renderer?.handleSessionEvent({
      scope: 'run',
      streamId,
      event: {
        type: 'status',
        streamId,
        phase: STREAM_PHASE.COMPLETED,
        previousPhase: STREAM_PHASE.RUNNING,
        cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
      },
    });

    expect(output.text).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · drafting · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · drafting · subagent: review · 0s\n' +
        '[r1/2] · polish paper.tex · done · tools: 3 · 0s\n',
    );
  });

  it('keeps the root run visible when child streams update progress', () => {
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        nowMs: () => 0,
      },
    );

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'coordinator',
        inputFiles: ['main.tex'],
      }),
    );
    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'child-stream',
        agent: 'reviewer',
        inputFiles: ['chapter.tex'],
      }),
    );
    renderer?.handle('updateStreamDescription', {
      streamId: 'child-stream',
      description: 'reviewing chapter.tex',
    });
    renderer?.handle('updateActiveSubagents', {
      parentStreamId: 'root-stream',
      children: [
        {
          executionId: 'child-1',
          childStreamId: 'child-stream',
          agentName: 'reviewer',
          status: 'running',
        },
        {
          executionId: 'child-2',
          childStreamId: 'child-stream-2',
          agentName: 'compiler',
          status: 'running',
        },
        {
          executionId: 'child-3',
          childStreamId: 'child-stream-3',
          agentName: 'proofreader',
          status: 'running',
        },
      ],
    });

    expect(output.text).toBe(
      'coordinator main.tex · 0s\n' +
        'coordinator main.tex · subagents: reviewer +2 · 0s\n',
    );
  });

  it('ticks the ANSI status line while an active subagent is quiet', () => {
    let now = 0;
    const output = outputBuffer();
    let heartbeat: (() => void) | undefined;
    let clearCount = 0;
    const renderer = createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => now,
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        clearCount += 1;
      }) as typeof clearInterval,
    });

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    now = 950;
    renderer?.handle('updateActiveSubagents', {
      parentStreamId: 'root-stream',
      children: [
        {
          executionId: 'child-1',
          childStreamId: 'child-stream',
          agentName: 'review',
          status: 'running',
        },
      ],
    });

    expect(heartbeat).toBeDefined();
    now = 1000;
    heartbeat?.();
    now = 2300;
    heartbeat?.();

    expect(output.text).toContain(
      '\r\x1b[2Korchestrator · subagent: review · 1s',
    );
    expect(output.text).toContain(
      '\r\x1b[2Korchestrator · subagent: review · 2s',
    );

    renderer?.handle('updateStreamStatus', {
      streamId: 'root-stream',
      status: STREAM_PHASE.CANCELLED,
      previousStatus: STREAM_PHASE.RUNNING,
    });
    expect(clearCount).toBe(1);
  });

  it('keeps heartbeat alive when active child names are unavailable', () => {
    let now = 0;
    const output = outputBuffer();
    let heartbeat: (() => void) | undefined;
    const renderer = createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => now,
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
    });

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    renderer?.handle('updateActiveSubagents', {
      parentStreamId: 'root-stream',
      children: [
        {
          executionId: 'child-1',
          childStreamId: 'child-stream',
          agentName: '',
          status: 'running',
        },
      ],
    });

    expect(heartbeat).toBeDefined();
    now = 1200;
    heartbeat?.();

    expect(output.text).toContain('\r\x1b[2Korchestrator · 1s');
  });

  it('stops active-child heartbeat when preserving the live line', () => {
    const output = outputBuffer();
    let clearCount = 0;
    const renderer = createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => 0,
      setInterval: (() => {
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        clearCount += 1;
      }) as typeof clearInterval,
    });

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    renderer?.handle('updateActiveSubagents', {
      parentStreamId: 'root-stream',
      children: [
        {
          executionId: 'child-1',
          childStreamId: 'child-stream',
          agentName: 'review',
          status: 'running',
        },
      ],
    });

    renderer?.preserve();

    expect(clearCount).toBe(1);
    expect(output.text.endsWith('\n')).toBe(true);
  });

  it('can add typed round progress after tool-call progress claims the root stream', () => {
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        minIntervalMs: 0,
        nowMs: () => 0,
      },
    );

    renderer?.handle('updateConversationProgress', {
      streamId: 'root-stream',
      progress: { toolCallCount: 4 },
    });
    renderer?.handle('updateRoundStage', {
      streamId: 'root-stream',
      roundStage: { index: 1 },
    });
    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'child-stream',
        agent: 'reviewer',
        inputFiles: ['chapter.tex'],
      }),
    );

    expect(output.text).toBe(
      'running · tools: 4 · 0s\n' + '[r2] · running · tools: 4 · 0s\n',
    );
  });

  it('keeps named active children visible when earlier entries are unnamed', () => {
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        nowMs: () => 0,
      },
    );

    renderer?.handle('setTaskState', workflowTaskState());
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'stream-1',
      processes: [
        {
          executionId: 'process-1',
          agentName: '',
          toolName: '',
          status: 'running',
        },
        {
          executionId: 'process-2',
          agentName: 'latexmk',
          status: 'running',
        },
      ],
    });

    expect(output.text).toBe(
      'polish paper.tex · 0s\npolish paper.tex · tool: latexmk · 0s\n',
    );
  });

  it('shows completed terminal stream stops as done', () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        minIntervalMs: 0,
        nowMs: () => now,
      },
    );

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'root-stream',
      processes: [
        {
          executionId: 'tool-1',
          agentName: 'bash',
          toolName: 'Bash',
          status: 'running',
        },
      ],
    });
    now = 11000;
    renderer?.handle('updateStreamStatus', {
      streamId: 'root-stream',
      status: STREAM_PHASE.COMPLETED,
      previousStatus: STREAM_STATUS.RUNNING,
    });
    renderer?.handle('updateStreamDescription', {
      streamId: 'root-stream',
      description: 'Running Mathematician multi-agent preset',
    });
    renderer?.handle('updateRoundStage', {
      streamId: 'root-stream',
      roundStage: { index: 2 },
    });
    renderer?.handle('updateConversationProgress', {
      streamId: 'root-stream',
      progress: { toolCallCount: 9 },
    });
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'root-stream',
      processes: [
        {
          executionId: 'tool-2',
          agentName: 'late-tool',
          toolName: 'LateTool',
          status: 'running',
        },
      ],
    });

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · tool: Bash · 0s\n' +
        'orchestrator · done · 11s\n',
    );
  });

  it('keeps interrupted terminal stream stops distinct from completion', () => {
    const output = outputBuffer();
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: output.write,
        minIntervalMs: 0,
        nowMs: () => 0,
      },
    );

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    renderer?.handle('updateStreamStatus', {
      streamId: 'root-stream',
      status: STREAM_PHASE.CANCELLED,
      previousStatus: STREAM_STATUS.RUNNING,
    });

    expect(output.text).toBe(
      'orchestrator · 0s\norchestrator · interrupted · 0s\n',
    );
  });

  it('uses a separate render flag from platform log suppression', () => {
    expect(
      createRunProgressRenderer(
        context({ quietLogs: true, renderRunProgress: true }),
      ),
    ).toBeDefined();
    expect(
      createRunProgressRenderer(context({ renderRunProgress: false })),
    ).toBe(undefined);
  });

  it('derives the run progress flag from quiet and structured-output contexts', () => {
    expect(shouldRenderRunProgress(context())).toBe(true);
    expect(shouldRenderRunProgress(context({ quietLogs: true }))).toBe(false);
    expect(shouldRenderRunProgress(context({ mode: 'headless' }))).toBe(true);
    expect(shouldRenderRunProgress(context({ outputFormat: 'json' }))).toBe(
      true,
    );
    expect(shouldRenderRunProgress(context({ outputFormat: 'ndjson' }))).toBe(
      false,
    );
    expect(shouldRenderRunProgress(context({ stderrIsTty: false }))).toBe(true);
  });

  it('routes progress events even when ordinary CLI logs are quiet', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const events = new SessionEventHub();
      const host = createCliRuntimeHost(
        context({ quietLogs: true, renderRunProgress: true }),
      );
      const detach = host.attachRunProgressRenderer(events);
      emitWorkflowRunConfig(events);
      detach();
      await host.close();
    });

    expect(output).toContain('polish paper.tex · 0s');
  });

  it('preserves the live progress line before interactive prompts', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const events = new SessionEventHub();
      const host = createCliRuntimeHost(
        context({
          approvalPolicy: 'ask',
          approvalPrompt: async () => 'n no review needed',
        }),
      );

      const detach = host.attachRunProgressRenderer(events);
      emitWorkflowRunConfig(events);
      host.prepareInteractivePrompt?.();
      await Promise.resolve();
      detach();
      await host.close();
    });

    expect(output).toContain('\r\x1b[2Kpolish paper.tex · 0s\n');
  });

  it('writes human progress to stderr without polluting json stdout', async () => {
    let stderr = '';
    const stdout = await captureStreamWrites(process.stdout, async () => {
      stderr = await captureStreamWrites(process.stderr, async () => {
        const events = new SessionEventHub();
        const host = createCliRuntimeHost(
          context({
            outputFormat: 'json',
            colorEnabled: false,
            renderRunProgress: true,
          }),
        );
        const detach = host.attachRunProgressRenderer(events);
        emitWorkflowRunConfig(events);
        detach();
        await host.close();
      });
    });

    expect(stderr).toContain('polish paper.tex · 0s');
    expect(stdout).toBe('');
  });

  it('writes subagent progress events to stdout in ndjson mode', async () => {
    const output = await captureStreamWrites(process.stdout, async () => {
      const host = createCliRuntimeHost(
        context({ outputFormat: 'ndjson', renderRunProgress: false }),
      );
      host.emit('updateActiveSubagents', {
        parentStreamId: 'parent-stream',
        children: [
          {
            kind: 'subagent',
            executionId: 'child-execution',
            childStreamId: 'child-stream',
            agentName: 'review',
            status: 'running',
          },
        ],
      });
      await host.close();
    });

    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records).toEqual([
      expect.objectContaining({
        kind: 'progress',
        event: 'updateActiveSubagents',
        payload: {
          parentStreamId: 'parent-stream',
          children: [
            {
              kind: 'subagent',
              executionId: 'child-execution',
              childStreamId: 'child-stream',
              agentName: 'review',
              status: 'running',
            },
          ],
        },
      }),
    ]);
  });

  it('does not write late ndjson progress after the runtime host closes', async () => {
    const output = await captureStreamWrites(process.stdout, async () => {
      const host = createCliRuntimeHost(
        context({ outputFormat: 'ndjson', renderRunProgress: false }),
      );
      host.emit('updateStreamStatus', {
        streamId: 'stream-1',
        status: STREAM_PHASE.RUNNING,
      });
      await host.close();
      host.emit('updateStreamDescription', {
        streamId: 'stream-1',
        description: 'late helper label',
      });
    });

    expect(output).not.toBe('');
    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records).toEqual([
      expect.objectContaining({
        kind: 'progress',
        event: 'updateStreamStatus',
      }),
    ]);
  });

  it('maps the global quiet flag into CLI context args', () => {
    expect(
      pickGlobalArgs({
        quiet: true,
        'output-format': 'text',
        'approval-policy': 'never',
      }).quiet,
    ).toBe(true);
  });
});
