import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { pickGlobalArgs } from '@cli/runtime/globalArgs';
import {
  createRunProgressRenderer,
  shouldRenderRunProgress,
} from '@cli/runtime/runProgressRenderer';
import { createCliRuntimeHost } from '@cli/runtime/runtimeHost';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import type { CliContext } from '@cli/runtime/cliContext';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type ConversationProgress,
  type ExecutionId,
  type InstructionAction,
  type RoundStage,
  type StreamPhase,
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

type RuntimePresentationNdjsonPolicy =
  | {
      readonly kind: 'log';
      readonly level: 'error' | 'info';
      readonly message: string;
      readonly fields: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'suppressed' };

type RuntimePresentationNdjsonCases = {
  [K in RuntimePresentationEvent]: {
    readonly payload: RuntimePresentationEventPayloads[K];
    readonly policy: RuntimePresentationNdjsonPolicy;
  };
};

const RUNTIME_PRESENTATION_NDJSON_CASES = {
  requestShowError: {
    payload: { message: 'Provider returned 500.' },
    policy: {
      kind: 'log',
      level: 'error',
      message: 'Provider returned 500.',
      fields: {},
    },
  },
  requestShowInstruction: {
    payload: {
      key: 'latex-compile-failed',
      message: 'Inspect the log before retrying.',
      actions: ['open-configuration-guide'],
      showSuppress: true,
    },
    policy: {
      kind: 'log',
      level: 'info',
      message: 'Inspect the log before retrying.',
      fields: {
        key: 'latex-compile-failed',
        actions: ['open-configuration-guide'],
        showSuppress: true,
      },
    },
  },
  requestOpenFile: {
    payload: {
      location: { kind: 'external', absolutePath: '/tmp/paper.tex' },
      preserveFocus: false,
    },
    policy: { kind: 'suppressed' },
  },
  showAgentConfigBanner: {
    payload: { agentName: 'polish' },
    policy: { kind: 'suppressed' },
  },
  requestEnsureProgressView: {
    payload: {},
    policy: { kind: 'suppressed' },
  },
} satisfies RuntimePresentationNdjsonCases;

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

type TestRunProgressRenderer = ReturnType<typeof createRunProgressRenderer>;

function handleRunConfig(
  renderer: TestRunProgressRenderer,
  taskState:
    | ReturnType<typeof workflowTaskState>
    | ReturnType<typeof toolUseTaskState> = workflowTaskState(),
): void {
  const streamId = taskState.streamId as StreamTabId;
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
}

function handleRoundStage(
  renderer: TestRunProgressRenderer,
  streamId: string,
  roundStage: RoundStage,
): void {
  renderer?.handleSessionEvent({
    scope: 'run',
    streamId: streamId as StreamTabId,
    event: {
      type: 'stage.start',
      id: `round-${roundStage.index}`,
      label: `Round ${roundStage.index + 1}`,
      kind: 'round',
      index: roundStage.index,
      ...(roundStage.total !== undefined ? { total: roundStage.total } : {}),
    },
  });
}

function handleConversationProgress(
  renderer: TestRunProgressRenderer,
  streamId: string,
  progress: ConversationProgress,
): void {
  renderer?.handleSessionEvent({
    scope: 'run',
    streamId: streamId as StreamTabId,
    event: {
      type: 'conversation.progress',
      progress,
    },
  });
}

function handleStreamStatus(
  renderer: TestRunProgressRenderer,
  streamId: string,
  status: StreamPhase,
): void {
  renderer?.handleSessionEvent({
    scope: 'run',
    streamId: streamId as StreamTabId,
    event: {
      type: 'status',
      streamId: streamId as StreamTabId,
      phase: status,
      previousPhase: STREAM_PHASE.RUNNING,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
    },
  });
}

function handleStreamDescription(
  renderer: TestRunProgressRenderer,
  streamId: string,
  description: string,
): void {
  renderer?.handleSessionEvent({
    scope: 'session',
    event: {
      type: 'updateStreamDescription',
      payload: { streamId: streamId as StreamTabId, description },
    },
  });
}

function handleActiveProcesses(
  renderer: TestRunProgressRenderer,
  parentStreamId: string,
  processes: readonly ActiveChildInfo[],
): void {
  renderer?.handleSessionEvent({
    scope: 'run',
    streamId: parentStreamId as StreamTabId,
    event: {
      type: 'child.activity',
      kind: 'processes',
      parentStreamId: parentStreamId as StreamTabId,
      processes,
    },
  });
}

function handleActiveSubagents(
  renderer: TestRunProgressRenderer,
  parentStreamId: string,
  children: readonly ActiveChildInfo[],
): void {
  renderer?.handleSessionEvent({
    scope: 'run',
    streamId: parentStreamId as StreamTabId,
    event: {
      type: 'child.activity',
      kind: 'subagents',
      parentStreamId: parentStreamId as StreamTabId,
      children,
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
    handleRunConfig(renderer, workflowTaskState());
    expect(output.text).toBe('\r\x1b[2Kpolish paper.tex · 0s');

    now = 1200;
    handleRoundStage(renderer, 'stream-1', { index: 1 });
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
    handleRunConfig(renderer, workflowTaskState());

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

    handleRunConfig(renderer, workflowTaskState());

    expect(heartbeat).toBeDefined();
    now = 1000;
    heartbeat?.();
    now = 2300;
    heartbeat?.();

    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 1s');
    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 2s');

    handleStreamStatus(renderer, 'stream-1', STREAM_PHASE.CANCELLED);
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

    handleRunConfig(
      renderer,
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

    handleRunConfig(renderer, workflowTaskState());
    handleRoundStage(renderer, 'stream-1', { index: 0 });

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

    handleRunConfig(
      renderer,
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

    handleRunConfig(renderer, workflowTaskState());
    handleStreamDescription(renderer, 'stream-1', 'drafting');
    handleActiveProcesses(renderer, 'stream-1', [
      {
        kind: 'process',
        executionId: 'process-1',
        agentName: 'bash',
        toolName: 'Bash',
        status: 'running',
      },
    ]);

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

    handleRunConfig(
      renderer,
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'coordinator',
        inputFiles: ['main.tex'],
      }),
    );
    handleRunConfig(
      renderer,
      workflowTaskState({
        streamId: 'child-stream',
        agent: 'reviewer',
        inputFiles: ['chapter.tex'],
      }),
    );
    handleStreamDescription(renderer, 'child-stream', 'reviewing chapter.tex');
    handleActiveSubagents(renderer, 'root-stream', [
      {
        kind: 'subagent',
        executionId: 'child-1',
        childStreamId: 'child-stream',
        agentName: 'reviewer',
        status: 'running',
      },
      {
        kind: 'subagent',
        executionId: 'child-2',
        childStreamId: 'child-stream-2',
        agentName: 'compiler',
        status: 'running',
      },
      {
        kind: 'subagent',
        executionId: 'child-3',
        childStreamId: 'child-stream-3',
        agentName: 'proofreader',
        status: 'running',
      },
    ]);

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

    handleRunConfig(
      renderer,
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    now = 950;
    handleActiveSubagents(renderer, 'root-stream', [
      {
        kind: 'subagent',
        executionId: 'child-1',
        childStreamId: 'child-stream',
        agentName: 'review',
        status: 'running',
      },
    ]);

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

    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);
    expect(clearCount).toBe(1);
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

    handleRunConfig(
      renderer,
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    handleActiveSubagents(renderer, 'root-stream', [
      {
        kind: 'subagent',
        executionId: 'child-1',
        childStreamId: 'child-stream',
        agentName: 'review',
        status: 'running',
      },
    ]);

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

    handleConversationProgress(renderer, 'root-stream', { toolCallCount: 4 });
    handleRoundStage(renderer, 'root-stream', { index: 1 });
    handleRunConfig(
      renderer,
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

    handleRunConfig(renderer, workflowTaskState());
    handleActiveProcesses(renderer, 'stream-1', [
      {
        kind: 'process',
        executionId: 'process-1',
        agentName: '',
        toolName: '',
        status: 'running',
      },
      {
        kind: 'process',
        executionId: 'process-2',
        agentName: 'latexmk',
        status: 'running',
      },
    ]);

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

    handleRunConfig(
      renderer,
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    handleActiveProcesses(renderer, 'root-stream', [
      {
        kind: 'process',
        executionId: 'tool-1',
        agentName: 'bash',
        toolName: 'Bash',
        status: 'running',
      },
    ]);
    now = 11000;
    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.COMPLETED);
    handleStreamDescription(
      renderer,
      'root-stream',
      'Running Mathematician multi-agent preset',
    );
    handleRoundStage(renderer, 'root-stream', { index: 2 });
    handleConversationProgress(renderer, 'root-stream', { toolCallCount: 9 });
    handleActiveProcesses(renderer, 'root-stream', [
      {
        kind: 'process',
        executionId: 'tool-2',
        agentName: 'late-tool',
        toolName: 'LateTool',
        status: 'running',
      },
    ]);

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

    handleRunConfig(
      renderer,
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);

    expect(output.text).toBe(
      'orchestrator · 0s\norchestrator · interrupted · 0s\n',
    );
  });

  it('freezes on a failed terminal stream stop, same as completed/cancelled', () => {
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

    handleRunConfig(
      renderer,
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.FAILED);
    // Post-terminal activity must not un-freeze the renderer (STREAM_PHASE.FAILED
    // must be recognized as a terminal outcome phase, same as COMPLETED/CANCELLED).
    handleConversationProgress(renderer, 'root-stream', { toolCallCount: 9 });
    handleActiveProcesses(renderer, 'root-stream', [
      {
        kind: 'process',
        executionId: 'tool-2',
        agentName: 'late-tool',
        toolName: 'LateTool',
        status: 'running',
      },
    ]);

    expect(output.text).toBe('orchestrator · 0s\norchestrator · error · 0s\n');
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

  it('deduplicates matching run and session stream-status facts', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const events = new SessionEventHub();
      const host = createCliRuntimeHost(
        context({
          colorEnabled: false,
          quietLogs: true,
          renderRunProgress: true,
        }),
      );
      const detach = host.attachRunProgressRenderer(events);

      emitWorkflowRunConfig(events);
      events.emit({
        scope: 'run',
        streamId: 'stream-1' as StreamTabId,
        event: {
          type: 'status',
          streamId: 'stream-1' as StreamTabId,
          phase: STREAM_PHASE.COMPLETED,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
        },
      });
      events.emit({
        scope: 'session',
        event: {
          type: 'updateStreamStatus',
          payload: {
            streamId: 'stream-1' as StreamTabId,
            status: STREAM_PHASE.COMPLETED,
          },
        },
      });

      detach();
      await host.close();
    });

    expect(output).toBe(
      'polish paper.tex · 0s\npolish paper.tex · done · 0s\n',
    );
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

  it('prints requestShowInstruction text and a human-readable action hint to stderr in text mode', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const host = createCliRuntimeHost(context({ outputFormat: 'text' }));

      host.emit('requestShowInstruction', {
        key: 'missingApiKey',
        message:
          'API key not found. Set your API key in Settings and run again.',
        actions: ['set-api-key', 'open-configuration-guide'],
        showSuppress: false,
      });

      await host.close();
    });

    // The raw InstructionAction tokens are translated to human phrasing
    // (mirroring the extension's INSTRUCTION_ACTION_VIEW), not printed
    // verbatim.
    expect(output).toContain(
      'API key not found. Set your API key in Settings and run again. (set your API key (texra setup), see the configuration guide)',
    );
    expect(output).not.toContain('set-api-key');
    expect(output).not.toContain('open-configuration-guide');
  });

  it('falls back to the raw token for an unrecognized action in the instruction hint', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const host = createCliRuntimeHost(context({ outputFormat: 'text' }));

      host.emit('requestShowInstruction', {
        key: 'futureInstruction',
        message: 'Something needs attention.',
        actions: ['some-future-action' as InstructionAction],
        showSuppress: false,
      });

      await host.close();
    });

    expect(output).toContain('Something needs attention. (some-future-action)');
  });

  it('does not gate requestShowInstruction behind quietLogs in text mode', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const host = createCliRuntimeHost(
        context({ outputFormat: 'text', quietLogs: true }),
      );

      host.emit('requestShowInstruction', {
        key: 'missingApiKey',
        message:
          'API key not found. Set your API key in Settings and run again.',
      });

      await host.close();
    });

    expect(output).toContain('API key not found.');
  });

  it('writes projected subagent progress records to stdout in ndjson mode', async () => {
    const output = await captureStreamWrites(process.stdout, async () => {
      const events = new SessionEventHub();
      const detach = attachCliSessionProgressProjection(events);
      events.emit({
        scope: 'run',
        streamId: 'parent-stream' as StreamTabId,
        event: {
          type: 'child.activity',
          kind: 'subagents',
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
      });
      detach();
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

  it('applies an explicit ndjson policy to every runtime presentation request', async () => {
    const output = await captureStreamWrites(process.stdout, async () => {
      const host = createCliRuntimeHost(
        context({ mode: 'headless', outputFormat: 'ndjson' }),
      );

      for (const [event, testCase] of Object.entries(
        RUNTIME_PRESENTATION_NDJSON_CASES,
      ) as [
        RuntimePresentationEvent,
        RuntimePresentationNdjsonCases[RuntimePresentationEvent],
      ][]) {
        host.emit(event, testCase.payload);
      }

      await host.close();
    });

    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const expectedRecords = Object.values(
      RUNTIME_PRESENTATION_NDJSON_CASES,
    ).flatMap(({ policy }) =>
      policy.kind === 'log'
        ? [expect.objectContaining({ ...policy, ts: expect.any(String) })]
        : [],
    );
    expect(records).toEqual(expectedRecords);
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
