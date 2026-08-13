import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import {
  SessionEventHub,
  type SessionEvent,
} from '@agent/runtime/SessionEventHub';
import { pickGlobalArgs } from '@cli/runtime/globalArgs';
import {
  createRunProgressRenderer,
  shouldRenderRunProgress,
  type RunProgressRendererInit,
} from '@cli/runtime/runProgressRenderer';
import { createCliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import { textDisplayWidth } from '@cli/runtime/terminalText';
import type { CliContext } from '@cli/runtime/cliContext';
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type ConversationProgress,
  type ExecutionId,
  type InstructionAction,
  type RoundStage,
  type StreamPhase,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
}));

function context(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    mode: 'interactive',
    renderRunProgress: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    ...overrides,
  });
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

// context() always sets renderRunProgress: true, so the factory never
// returns undefined inside these helpers.
type TestRunProgressRenderer = NonNullable<
  ReturnType<typeof createRunProgressRenderer>
>;

type RunConfigOverrides = {
  streamId?: string;
  agent?: string;
  agentCategory?: AgentCategory;
  inputFiles?: string[];
};

function runConfigEvent(overrides: RunConfigOverrides = {}): SessionEvent {
  const streamId = (overrides.streamId ?? 'stream-1') as StreamTabId;
  return {
    scope: 'run',
    streamId,
    event: {
      type: 'run.config',
      streamId,
      executionId: 'execution-1' as ExecutionId,
      config: AgentConfigSchema.parse({
        agent: overrides.agent ?? 'polish',
        agentCategory: overrides.agentCategory ?? AgentCategory.Workflow,
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
      }),
    },
  };
}

function subagentChild(
  overrides: Partial<ActiveChildInfo> = {},
): ActiveChildInfo {
  return {
    executionId: 'child-1',
    childStreamId: 'child-stream',
    agentName: 'review',
    identity: { kind: 'agent', agent: 'review' },
    status: 'running',
    ...overrides,
  };
}

function handleRunConfig(
  renderer: TestRunProgressRenderer,
  overrides: RunConfigOverrides = {},
): void {
  renderer.handleSessionEvent(runConfigEvent(overrides));
}

/** Input-less root run the heartbeat and live-line cases below all start from. */
function handleOrchestratorRootRun(renderer: TestRunProgressRenderer): void {
  handleRunConfig(renderer, {
    streamId: 'root-stream',
    agent: 'orchestrator',
    inputFiles: [],
  });
}

function handleRoundStage(
  renderer: TestRunProgressRenderer,
  streamId: string,
  roundStage: RoundStage,
): void {
  renderer.handleSessionEvent({
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
  renderer.handleSessionEvent({
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
  previousStatus: StreamPhase = STREAM_PHASE.RUNNING,
): void {
  // Status reaches the renderer on the session-fact rail only.
  renderer.handleSessionEvent({
    scope: 'session',
    event: {
      type: 'status',
      streamId: streamId as StreamTabId,
      phase: status,
      previousPhase: previousStatus,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
    },
  });
}

function handleFollowUpSent(
  renderer: TestRunProgressRenderer,
  streamId: string,
): void {
  renderer.handleSessionEvent({
    scope: 'session',
    event: {
      type: 'followUpSent',
      payload: { streamId: streamId as StreamTabId },
    },
  });
}

function handleStreamDescription(
  renderer: TestRunProgressRenderer,
  streamId: string,
  description: string,
): void {
  renderer.handleSessionEvent({
    scope: 'session',
    event: {
      type: 'updateStreamDescription',
      payload: { streamId: streamId as StreamTabId, description },
    },
  });
}

function handleRemoveStream(
  renderer: TestRunProgressRenderer,
  streamId: string,
): void {
  renderer.handleSessionEvent({
    scope: 'session',
    event: {
      type: 'removeStream',
      payload: { streamId: streamId as StreamTabId },
    },
  });
}

function handleActiveSubagents(
  renderer: TestRunProgressRenderer,
  parentStreamId: string,
  children: readonly ActiveChildInfo[],
): void {
  renderer.handleSessionEvent({
    scope: 'run',
    streamId: parentStreamId as StreamTabId,
    event: {
      type: 'child.activity',
      parentStreamId: parentStreamId as StreamTabId,
      items: children,
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

function plainRenderer(
  output: ReturnType<typeof outputBuffer>,
  init: Partial<RunProgressRendererInit> = {},
): TestRunProgressRenderer {
  return createRunProgressRenderer(context({ stderrColorEnabled: false }), {
    colorEnabled: false,
    write: output.write,
    nowMs: () => 0,
    ...init,
  })!;
}

function ansiRenderer(
  output: ReturnType<typeof outputBuffer>,
  init: Partial<RunProgressRendererInit> = {},
): TestRunProgressRenderer {
  return createRunProgressRenderer(context(), {
    colorEnabled: true,
    write: output.write,
    nowMs: () => 0,
    ...init,
  })!;
}

function fakeTimers() {
  const timers = {
    heartbeat: undefined as (() => void) | undefined,
    clearCount: 0,
    setInterval: ((callback: () => void) => {
      timers.heartbeat = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      timers.clearCount += 1;
    }) as typeof clearInterval,
  };
  return timers;
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

function ndjsonRecords(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
    const renderer = ansiRenderer(output, { nowMs: () => now });

    handleRunConfig(renderer);
    expect(output.text).toBe('\r\x1b[2Kpolish paper.tex · 0s');

    now = 1200;
    handleRoundStage(renderer, 'stream-1', { index: 1 });
    expect(output.text).toContain('\r\x1b[2K[r2] · polish paper.tex · 1s');

    renderer.clear();
    expect(output.text.endsWith('\r\x1b[2K')).toBe(true);
  });

  it('keeps long elapsed times in minute-second form', () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { nowMs: () => now });

    now = 3_600_000;
    handleRunConfig(renderer);

    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 60m 00s');
  });

  it('ticks the ANSI status line while a root workflow is quiet', () => {
    let now = 0;
    const output = outputBuffer();
    const timers = fakeTimers();
    const renderer = ansiRenderer(output, { nowMs: () => now, ...timers });

    handleRunConfig(renderer);

    expect(timers.heartbeat).toBeDefined();
    now = 1000;
    timers.heartbeat?.();
    now = 2300;
    timers.heartbeat?.();

    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 1s');
    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 2s');

    handleStreamStatus(renderer, 'stream-1', STREAM_PHASE.CANCELLED);
    expect(timers.clearCount).toBe(1);
  });

  it('summarizes multi-input workflow progress without hiding extra files', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleRunConfig(renderer, {
      inputFiles: ['number-theory.tex', 'algebra.tex'],
    });

    expect(output.text).toBe('polish number-theory.tex +1 · 0s\n');
  });

  it('shows planned workflow rounds before the first model turn', () => {
    mocks.getAgent.mockReturnValue({
      rounds: 2,
    });
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    handleRunConfig(renderer);
    handleRoundStage(renderer, 'stream-1', { index: 0 });

    expect(mocks.getAgent).toHaveBeenCalledWith(
      'polish',
      AgentCategory.Workflow,
    );
    expect(output.text).toBe(
      'polish paper.tex · 2 rounds · 0s\n' + '[r1/2] · polish paper.tex · 0s\n',
    );
  });

  it('keeps the planned total when a workflow overruns its rounds', () => {
    mocks.getAgent.mockReturnValue({
      rounds: 3,
    });
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    handleRunConfig(renderer);
    handleRoundStage(renderer, 'stream-1', { index: 3 });

    expect(output.text).toBe(
      'polish paper.tex · 3 rounds · 0s\n' + '[r4/3] · polish paper.tex · 0s\n',
    );
  });

  it('does not add workflow round hints to tool-use progress', () => {
    mocks.getAgent.mockReturnValue({
      rounds: 2,
    });
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleRunConfig(renderer, {
      agentCategory: AgentCategory.ToolUse,
      inputFiles: [],
    });

    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(output.text).toBe('polish · 0s\n');
  });

  it('prints phase changes on separate lines when ANSI is disabled', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleRunConfig(renderer);
    handleStreamDescription(renderer, 'stream-1', 'drafting');
    handleActiveSubagents(renderer, 'stream-1', [subagentChild()]);

    expect(output.text).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · drafting · 0s\n' +
        'polish paper.tex · drafting · subagent: review · 0s\n',
    );
  });

  it('renders the live line from direct session and run facts', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });
    const streamId = 'stream-1';

    handleRunConfig(renderer, { streamId });
    handleConversationProgress(renderer, streamId, { toolCallCount: 3 });
    handleRoundStage(renderer, streamId, { index: 0, total: 2 });
    handleStreamDescription(renderer, streamId, 'drafting');
    handleActiveSubagents(renderer, streamId, [subagentChild()]);
    handleStreamStatus(renderer, streamId, STREAM_PHASE.COMPLETED);

    expect(output.text).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · drafting · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · drafting · subagent: review · 0s\n' +
        '[r1/2] · polish paper.tex · completed · tools: 3 · 0s\n',
    );
  });

  it('keeps the root run visible when child streams update progress', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleRunConfig(renderer, {
      streamId: 'root-stream',
      agent: 'coordinator',
      inputFiles: ['main.tex'],
    });
    handleRunConfig(renderer, {
      streamId: 'child-stream',
      agent: 'reviewer',
      inputFiles: ['chapter.tex'],
    });
    handleStreamDescription(renderer, 'child-stream', 'reviewing chapter.tex');
    handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({ agentName: 'reviewer' }),
      subagentChild({
        executionId: 'child-2',
        childStreamId: 'child-stream-2',
        agentName: 'compiler',
      }),
      subagentChild({
        executionId: 'child-3',
        childStreamId: 'child-stream-3',
        agentName: 'proofreader',
      }),
    ]);

    expect(output.text).toBe(
      'coordinator main.tex · 0s\n' +
        'coordinator main.tex · subagents: reviewer — reviewing chapter.tex +2 · 0s\n',
    );
  });

  it('ticks the ANSI status line while an active subagent is quiet', () => {
    let now = 0;
    const output = outputBuffer();
    const timers = fakeTimers();
    const renderer = ansiRenderer(output, { nowMs: () => now, ...timers });

    handleOrchestratorRootRun(renderer);
    now = 950;
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(timers.heartbeat).toBeDefined();
    now = 1000;
    timers.heartbeat?.();
    now = 2300;
    timers.heartbeat?.();

    expect(output.text).toContain(
      '\r\x1b[2Korchestrator · subagent: review · 1s',
    );
    expect(output.text).toContain(
      '\r\x1b[2Korchestrator · subagent: review · 2s',
    );

    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);
    expect(timers.clearCount).toBe(1);
  });

  it('stops active-child heartbeat when preserving the live line', () => {
    const output = outputBuffer();
    const timers = fakeTimers();
    const renderer = ansiRenderer(output, timers);

    handleOrchestratorRootRun(renderer);
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    renderer.preserve();

    expect(timers.clearCount).toBe(1);
    expect(output.text.endsWith('\n')).toBe(true);
  });

  it('can add typed round progress after tool-call progress claims the root stream', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    handleConversationProgress(renderer, 'root-stream', { toolCallCount: 4 });
    handleRoundStage(renderer, 'root-stream', { index: 1 });
    handleRunConfig(renderer, {
      streamId: 'child-stream',
      agent: 'reviewer',
      inputFiles: ['chapter.tex'],
    });

    expect(output.text).toBe(
      'running · tools: 4 · 0s\n' + '[r2] · running · tools: 4 · 0s\n',
    );
  });

  it('keeps named active children visible when earlier entries are unnamed', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleRunConfig(renderer);
    handleActiveSubagents(renderer, 'stream-1', [
      subagentChild({ childStreamId: 'child-stream-1', agentName: '' }),
      subagentChild({
        executionId: 'child-2',
        childStreamId: 'child-stream-2',
      }),
    ]);

    expect(output.text).toBe(
      'polish paper.tex · 0s\npolish paper.tex · subagent: review · 0s\n',
    );
  });

  it('joins a child description emitted before the active roster', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(
      renderer,
      'child-stream',
      'Check multiplier\nsigns\tand \x1b[2Jresonance counterexamples',
    );
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Check multiplier signs and resonance counterexa… · 0s\n',
    );
  });

  it('adds a description that arrives after the child becomes active', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleStreamDescription(
      renderer,
      'child-stream',
      'Verify by constraint elimination and energy balance',
    );

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review · 0s\n' +
        'orchestrator · subagent: review — Verify by constraint elimination and energy bal… · 0s\n',
    );
  });

  it('redacts secrets from child descriptions', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(
      renderer,
      'child-stream',
      'Run API_TOKEN=supersecretvalue now',
    );
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Run API_TOKEN=[redacted] now · 0s\n',
    );
  });

  it('drops the previous task when a waiting child begins a follow-up turn', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'Initial review task');
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleFollowUpSent(renderer, 'child-stream');

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Initial review task · 0s\n' +
        'orchestrator · subagent: review · 0s\n',
    );

    // The status subscriber may repaint the roster before this renderer sees
    // WAITING -> RUNNING. That repaint must not recover the previous label.
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.WAITING);
    handleStreamStatus(
      renderer,
      'child-stream',
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.WAITING,
    );

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Initial review task · 0s\n' +
        'orchestrator · subagent: review · 0s\n',
    );
  });

  it('keeps the current task across a same-turn manual retry', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'Current review task');
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.WAITING);
    handleStreamStatus(
      renderer,
      'child-stream',
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.WAITING,
    );

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Current review task · 0s\n',
    );
  });

  it('prefers a running child over an earlier waiting child', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'waiting-child', 'Idle review task');
    handleStreamDescription(renderer, 'running-child', 'Active review task');
    handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        childStreamId: 'waiting-child',
        status: STREAM_PHASE.WAITING,
      }),
      subagentChild({
        executionId: 'child-2',
        childStreamId: 'running-child',
        status: STREAM_PHASE.RUNNING,
      }),
    ]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagents: review — Active review task +1 · 0s\n',
    );
  });

  it('fits the delegated task within an ANSI terminal row', () => {
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { columns: 80 });

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'A'.repeat(100));
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    const renderedLines = output.text.split('\r\x1b[2K').filter(Boolean);
    expect(renderedLines).toHaveLength(2);
    expect(renderedLines.at(-1)).toContain('subagent: review — ');
    expect(renderedLines.every((line) => textDisplayWidth(line) <= 80)).toBe(
      true,
    );
  });

  it('recalculates the delegated task width after a terminal resize', () => {
    let columns = 100;
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { getColumns: () => columns });

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'A'.repeat(100));
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    columns = 60;
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    const renderedLines = output.text.split('\r\x1b[2K').filter(Boolean);
    expect(renderedLines).toHaveLength(3);
    expect(textDisplayWidth(renderedLines.at(-1) ?? '')).toBeLessThanOrEqual(
      60,
    );
  });

  it('forgets a child description when that child becomes terminal', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'First review task');
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.COMPLETED);
    handleActiveSubagents(renderer, 'root-stream', []);
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — First review task · 0s\n' +
        'orchestrator · subagent: review · 0s\n' +
        'orchestrator · 0s\n' +
        'orchestrator · subagent: review · 0s\n',
    );
  });

  it('ignores a description that arrives after the child becomes terminal', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'First review task');
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.COMPLETED);
    handleStreamDescription(renderer, 'child-stream', 'Late generated label');

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — First review task · 0s\n' +
        'orchestrator · subagent: review · 0s\n',
    );
  });

  it('accepts a description for a new incarnation of a closed child ID', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'First review task');
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.COMPLETED);
    handleRunConfig(renderer, { streamId: 'child-stream', agent: 'review' });
    handleStreamDescription(renderer, 'child-stream', 'Relaunched review task');

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — First review task · 0s\n' +
        'orchestrator · subagent: review · 0s\n' +
        'orchestrator · subagent: review — Relaunched review task · 0s\n',
    );
  });

  it('forgets a child description when that child stream is removed', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'Removed review task');
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleRemoveStream(renderer, 'child-stream');
    handleActiveSubagents(renderer, 'root-stream', []);
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Removed review task · 0s\n' +
        'orchestrator · subagent: review · 0s\n' +
        'orchestrator · 0s\n' +
        'orchestrator · subagent: review · 0s\n',
    );
  });

  it('shows completed terminal stream stops with the shared cli wording', () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = plainRenderer(output, {
      minIntervalMs: 0,
      nowMs: () => now,
    });

    handleOrchestratorRootRun(renderer);
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    now = 11000;
    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.COMPLETED);
    handleStreamDescription(
      renderer,
      'root-stream',
      'Running Mathematician multi-agent preset',
    );
    handleRoundStage(renderer, 'root-stream', { index: 2 });
    handleConversationProgress(renderer, 'root-stream', { toolCallCount: 9 });
    handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        executionId: 'child-2',
        childStreamId: 'late-child-stream',
        agentName: 'late-review',
      }),
    ]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review · 0s\n' +
        'orchestrator · completed · 11s\n',
    );
  });

  it('keeps cancelled terminal stream stops distinct from completion', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    handleOrchestratorRootRun(renderer);
    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);

    expect(output.text).toBe(
      'orchestrator · 0s\norchestrator · stopped · 0s\n',
    );
  });

  it('does not repaint a child after the root stream is terminal', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    handleOrchestratorRootRun(renderer);
    handleStreamDescription(renderer, 'child-stream', 'Late review task');
    handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);
    handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.CANCELLED);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Late review task · 0s\n' +
        'orchestrator · stopped · 0s\n',
    );
  });

  it('freezes on a failed terminal stream stop, same as completed/cancelled', () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    handleOrchestratorRootRun(renderer);
    handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.FAILED);
    // Post-terminal activity must not un-freeze the renderer (STREAM_PHASE.FAILED
    // must be recognized as a terminal outcome phase, same as COMPLETED/CANCELLED).
    handleConversationProgress(renderer, 'root-stream', { toolCallCount: 9 });
    handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        executionId: 'child-2',
        childStreamId: 'late-child-stream',
        agentName: 'late-review',
      }),
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

  it('uses the stderr color gate when stdout alone allows color', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const events = new SessionEventHub();
      const host = createCliRuntimeHost(
        context({
          quietLogs: true,
          renderRunProgress: true,
          stdoutColorEnabled: true,
          stderrColorEnabled: false,
        }),
      );
      const detach = host.attachRunProgressRenderer(events);
      events.emit(runConfigEvent());
      detach();
      await host.close();
    });

    expect(output).toContain('polish paper.tex · 0s');
    expect(output).not.toContain('\r\x1b[2K');
  });

  it('writes one status line when a run-scope status fact accompanies the session fact', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const events = new SessionEventHub();
      const host = createCliRuntimeHost(
        context({
          stderrColorEnabled: false,
          quietLogs: true,
          renderRunProgress: true,
        }),
      );
      const detach = host.attachRunProgressRenderer(events);

      events.emit(runConfigEvent());
      // Status travels only as a session fact (run-scope status is no longer
      // representable), so exactly one line renders for the transition.
      events.emit({
        scope: 'session',
        event: {
          type: 'status',
          streamId: 'stream-1' as StreamTabId,
          phase: STREAM_PHASE.COMPLETED,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
        },
      });

      detach();
      await host.close();
    });

    expect(output).toBe(
      'polish paper.tex · 0s\npolish paper.tex · completed · 0s\n',
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
      events.emit(runConfigEvent());
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
            stderrColorEnabled: false,
            renderRunProgress: true,
          }),
        );
        const detach = host.attachRunProgressRenderer(events);
        events.emit(runConfigEvent());
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
          parentStreamId: 'parent-stream',
          items: [
            {
              executionId: 'child-execution',
              childStreamId: 'child-stream',
              agentName: 'review',
              identity: { kind: 'agent' as const, agent: 'review' },
              status: 'running',
            },
          ],
        },
      });
      detach();
    });

    const records = ndjsonRecords(output);

    expect(records).toEqual([
      expect.objectContaining({
        kind: 'progress',
        event: 'updateActiveSubagents',
        // The frozen public row shape: `kind` discriminant, no `identity`.
        payload: {
          parentStreamId: 'parent-stream',
          children: [
            {
              kind: 'subagent',
              executionId: 'child-execution',
              agentName: 'review',
              status: 'running',
              childStreamId: 'child-stream',
            },
          ],
        },
      }),
    ]);
  });

  it('preserves approval bypass records in ndjson mode', async () => {
    const output = await captureStreamWrites(process.stdout, async () => {
      const host = createCliRuntimeHost(
        context({ mode: 'headless', outputFormat: 'ndjson' }),
      );

      host.emitApprovalBypassState({
        streamId: 'stream-1',
        kind: 'bash',
        bypassActive: true,
      });
      host.emitApprovalBypassState({
        streamId: 'stream-1',
        kind: 'toolEdit',
        bypassActive: false,
      });
      host.emitApprovalBypassState({
        streamId: 'stream-1',
        kind: 'superYolo',
        bypassActive: true,
      });

      await host.close();
    });

    const records = ndjsonRecords(output);

    expect(records).toEqual([
      expect.objectContaining({
        kind: 'progress',
        event: 'updateBashApprovalBypassState',
        payload: { streamId: 'stream-1', bypassActive: true },
      }),
      expect.objectContaining({
        kind: 'progress',
        event: 'updateToolEditApprovalBypassState',
        payload: { streamId: 'stream-1', bypassActive: false },
      }),
      expect.objectContaining({
        kind: 'progress',
        event: 'updateSuperYoloBypassState',
        payload: { streamId: 'stream-1', bypassActive: true },
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

    const records = ndjsonRecords(output);

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
