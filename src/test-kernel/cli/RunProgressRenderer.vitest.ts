import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Effect, SubscriptionRef } from 'effect';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { pickGlobalArgs } from '@cli/runtime/globalArgs';
import {
  createRunProgressRenderer,
  shouldRenderRunProgress,
  type RunProgressRenderer,
  type RunProgressRendererInit,
} from '@cli/runtime/runProgressRenderer';
import { createCliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import { textDisplayWidth } from '@cli/runtime/terminalText';
import type { CliContext } from '@cli/runtime/cliContext';
import {
  aggregateId as qualifyAggregateId,
  STREAM_PHASE,
  type ActiveChildInfo,
  type ConversationProgress,
  type ExecutionId,
  type InstructionAction,
  type RoundStage,
  type StreamPhase,
  type StreamTabId,
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { makeStreamView, viewWith } from './fixtures/sessionViewFixture';

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
    payload: { agentName: 'polish', category: AgentCategory.ToolUse },
    policy: {
      kind: 'log',
      level: 'error',
      message:
        'Agent not found: polish. Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team preset.',
      fields: {},
    },
  },
  requestEnsureProgressView: {
    payload: {},
    policy: { kind: 'suppressed' },
  },
} satisfies RuntimePresentationNdjsonCases;

// context() always sets renderRunProgress: true, so the factory never
// returns undefined inside these helpers. Facts reach the renderer the way
// they do in production: as the session view the fold publishes, so each
// helper states the stream fields the fold would state and settles the ref.
type TestRunProgressRenderer = RunProgressRenderer & {
  readonly streams: Map<StreamTabId, StreamView>;
  set(streamId: string, over: Partial<StreamView>): Promise<void>;
  setMany(
    entries: ReadonlyArray<readonly [string, Partial<StreamView>]>,
  ): Promise<void>;
  detach(): void;
};
let createdAt = 0;
/** Let the renderer's fiber observe the latest view before a case reads
 *  the output: a few turns of the event loop cover the stream pipeline. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
function attached(renderer: RunProgressRenderer): TestRunProgressRenderer {
  const streams = new Map<StreamTabId, StreamView>();
  const ref = Effect.runSync(SubscriptionRef.make<SessionView>(viewWith([])));
  const detach = renderer.attach({ view: ref });
  const setMany = async (
    entries: ReadonlyArray<readonly [string, Partial<StreamView>]>,
  ): Promise<void> => {
    for (const [streamId, over] of entries) {
      const id = streamId as StreamTabId;
      const current = streams.get(id);
      streams.set(
        id,
        makeStreamView({
          // The label, tone, and group follow the merged status.
          ...(current
            ? (({ statusLabel, tone, group, ...rest }) => rest)(current)
            : { createdAt: (createdAt += 1) }),
          ...over,
          id,
        } as Parameters<typeof makeStreamView>[0]) as StreamView,
      );
    }
    await Effect.runPromise(
      SubscriptionRef.set(ref, viewWith([...streams.values()])),
    );
    await settle();
  };
  return Object.assign(renderer, {
    streams,
    set: (streamId: string, over: Partial<StreamView>) =>
      setMany([[streamId, over]]),
    setMany,
    detach,
  });
}
type RunConfigOverrides = {
  streamId?: string;
  agent?: string;
  agentCategory?: AgentCategory;
  inputFiles?: string[];
};
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
/**
 * A run reaches the renderer the way a live one does: its `run.start` facts
 * (agent, category, inputs) with the RUNNING transition that follows.
 */
async function handleRunConfig(
  renderer: TestRunProgressRenderer,
  overrides: RunConfigOverrides = {},
): Promise<void> {
  const agent = overrides.agent ?? 'polish';
  await renderer.set(overrides.streamId ?? 'stream-1', {
    identity: { kind: 'agent', agent },
    label: agent,
    category: overrides.agentCategory ?? AgentCategory.Workflow,
    inputFiles: overrides.inputFiles ?? ['paper.tex'],
    status: STREAM_PHASE.RUNNING,
  } as Partial<StreamView>);
}
/** Input-less root run the heartbeat and live-line cases below all start from. */
async function handleOrchestratorRootRun(
  renderer: TestRunProgressRenderer,
): Promise<void> {
  await handleRunConfig(renderer, {
    streamId: 'root-stream',
    agent: 'orchestrator',
    inputFiles: [],
  });
}
async function handleRoundStage(
  renderer: TestRunProgressRenderer,
  streamId: string,
  roundStage: RoundStage,
): Promise<void> {
  await renderer.set(streamId, {
    stage: {
      kind: 'round',
      index: roundStage.index,
      ...(roundStage.total !== undefined ? { total: roundStage.total } : {}),
    },
  });
}
async function handleConversationProgress(
  renderer: TestRunProgressRenderer,
  streamId: string,
  progress: ConversationProgress,
): Promise<void> {
  await renderer.set(streamId, { conversationProgress: progress });
}
async function handleStreamStatus(
  renderer: TestRunProgressRenderer,
  streamId: string,
  status: StreamPhase,
): Promise<void> {
  await renderer.set(streamId, { status });
}
async function handleStreamDescription(
  renderer: TestRunProgressRenderer,
  streamId: string,
  description: string,
): Promise<void> {
  await renderer.set(streamId, { description });
}
/** The parent's roster as the fold states it, in one view: each named
 *  child is a live child stream, and a child that left the roster has
 *  finished. An unnamed entry has no stream to show. */
async function handleActiveSubagents(
  renderer: TestRunProgressRenderer,
  parentStreamId: string,
  children: readonly ActiveChildInfo[],
): Promise<void> {
  const parent = parentStreamId as StreamTabId;
  const named = children.filter((child) => child.agentName);
  const listed = new Set(named.map((child) => child.childStreamId));
  const entries: Array<readonly [string, Partial<StreamView>]> = [];
  for (const [id, stream] of renderer.streams) {
    if (stream.parentId === parent && !listed.has(id)) {
      entries.push([id, { status: STREAM_PHASE.COMPLETED }]);
    }
  }
  for (const child of named) {
    entries.push([
      child.childStreamId,
      {
        parentId: parent,
        ancestors: [{ id: parent, label: parent }],
        executionId: child.executionId,
        label: child.agentName,
        identity: child.identity,
        status:
          child.status === 'running'
            ? STREAM_PHASE.RUNNING
            : (child.status ?? STREAM_PHASE.WAITING),
      },
    ]);
  }
  await renderer.setMany(entries);
}
/** A run on a real session: its `run.start`, the config the fold reads the
 *  inputs from, and the RUNNING transition, then the fold's own settle. */
async function publishRun(
  session: SessionHandle,
  overrides: RunConfigOverrides = {},
): Promise<void> {
  const streamId = (overrides.streamId ?? 'stream-1') as StreamTabId;
  const agent = overrides.agent ?? 'polish';
  const executionId = 'e00101' as ExecutionId;
  session.publish([
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('stream', streamId),
      executionId,
      identity: { kind: 'agent', agent },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: overrides.agentCategory ?? AgentCategory.Workflow,
      isRemote: false,
      worktree: null,
      parentStreamId: null,
      background: false,
      approvalPolicy: null,
      checkpointId: null,
    },
  ]);
  session.publishRunEvent(streamId, {
    type: 'run.config',
    streamId,
    executionId,
    config: AgentConfigSchema.parse({
      agent,
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
        autoCompileInputPdf: false,
      },
      memories: [],
      instruction: '',
      workingDirectory: '/tmp/project',
    }),
  });
  session.publishStatus({
    type: 'status',
    streamId,
    phase: STREAM_PHASE.RUNNING,
    cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
  });
  await settle();
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
  return attached(
    createRunProgressRenderer(context({ stderrColorEnabled: false }), {
      colorEnabled: false,
      write: output.write,
      nowMs: () => 0,
      // Every view change paints: the cases pin the line, not the throttle.
      minIntervalMs: 0,
      ...init,
    })!,
  );
}

function ansiRenderer(
  output: ReturnType<typeof outputBuffer>,
  init: Partial<RunProgressRendererInit> = {},
): TestRunProgressRenderer {
  return attached(
    createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => 0,
      minIntervalMs: 0,
      ...init,
    })!,
  );
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

  it('renders a single ANSI status line and clears it on close', async () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { nowMs: () => now });

    await handleRunConfig(renderer);
    expect(output.text).toBe('\r\x1b[2Kpolish paper.tex · 0s');

    now = 1200;
    await handleRoundStage(renderer, 'stream-1', { index: 1 });
    expect(output.text).toContain('\r\x1b[2K[r2] · polish paper.tex · 1s');

    renderer.clear();
    expect(output.text.endsWith('\r\x1b[2K')).toBe(true);
  });

  it('keeps long elapsed times in minute-second form', async () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { nowMs: () => now });

    now = 3_600_000;
    await handleRunConfig(renderer);

    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 60m 00s');
  });

  it('ticks the ANSI status line while a root workflow is quiet', async () => {
    let now = 0;
    const output = outputBuffer();
    const timers = fakeTimers();
    const renderer = ansiRenderer(output, { nowMs: () => now, ...timers });

    await handleRunConfig(renderer);

    expect(timers.heartbeat).toBeDefined();
    now = 1000;
    timers.heartbeat?.();
    now = 2300;
    timers.heartbeat?.();

    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 1s');
    expect(output.text).toContain('\r\x1b[2Kpolish paper.tex · 2s');

    await handleStreamStatus(renderer, 'stream-1', STREAM_PHASE.CANCELLED);
    expect(timers.clearCount).toBe(1);
  });

  it('summarizes multi-input workflow progress without hiding extra files', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleRunConfig(renderer, {
      inputFiles: ['number-theory.tex', 'algebra.tex'],
    });

    expect(output.text).toBe('polish number-theory.tex +1 · 0s\n');
  });

  it('shows planned workflow rounds before the first model turn', async () => {
    mocks.getAgent.mockReturnValue({
      rounds: 2,
    });
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleRunConfig(renderer);
    await handleRoundStage(renderer, 'stream-1', { index: 0 });

    expect(mocks.getAgent).toHaveBeenCalledWith(
      'polish',
      AgentCategory.Workflow,
    );
    expect(output.text).toBe(
      'polish paper.tex · 2 rounds · 0s\n' + '[r1/2] · polish paper.tex · 0s\n',
    );
  });

  it('keeps the planned total when a workflow overruns its rounds', async () => {
    mocks.getAgent.mockReturnValue({
      rounds: 3,
    });
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleRunConfig(renderer);
    await handleRoundStage(renderer, 'stream-1', { index: 3 });

    expect(output.text).toBe(
      'polish paper.tex · 3 rounds · 0s\n' + '[r4/3] · polish paper.tex · 0s\n',
    );
  });

  it('does not add workflow round hints to tool-use progress', async () => {
    mocks.getAgent.mockReturnValue({
      rounds: 2,
    });
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleRunConfig(renderer, {
      agentCategory: AgentCategory.ToolUse,
      inputFiles: [],
    });

    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(output.text).toBe('polish · 0s\n');
  });

  it('prints phase changes on separate lines when ANSI is disabled', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleRunConfig(renderer);
    await handleStreamDescription(renderer, 'stream-1', 'drafting');
    await handleActiveSubagents(renderer, 'stream-1', [subagentChild()]);

    expect(output.text).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · drafting · 0s\n' +
        'polish paper.tex · drafting · subagent: review · 0s\n',
    );
  });

  it('renders the live line from direct session and run facts', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });
    const streamId = 'stream-1';

    await handleRunConfig(renderer, { streamId });
    await handleConversationProgress(renderer, streamId, { toolCallCount: 3 });
    await handleRoundStage(renderer, streamId, { index: 0, total: 2 });
    await handleStreamDescription(renderer, streamId, 'drafting');
    await handleActiveSubagents(renderer, streamId, [subagentChild()]);
    await handleStreamStatus(renderer, streamId, STREAM_PHASE.COMPLETED);

    expect(output.text).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · drafting · tools: 3 · 0s\n' +
        '[r1/2] · polish paper.tex · drafting · subagent: review · 0s\n' +
        '[r1/2] · polish paper.tex · Completed · tools: 3 · 0s\n',
    );
  });

  it('keeps the root run visible when child streams update progress', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleRunConfig(renderer, {
      streamId: 'root-stream',
      agent: 'coordinator',
      inputFiles: ['main.tex'],
    });
    await handleRunConfig(renderer, {
      streamId: 'child-stream',
      agent: 'reviewer',
      inputFiles: ['chapter.tex'],
    });
    await handleStreamDescription(
      renderer,
      'child-stream',
      'reviewing chapter.tex',
    );
    await handleActiveSubagents(renderer, 'root-stream', [
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

    // The newest child leads the summary: `childIds` is the fold's
    // `streamOrdering` (newest creation first).
    expect(output.text).toBe(
      'coordinator main.tex · 0s\n' +
        'coordinator main.tex · subagents: proofreader +2 · 0s\n',
    );
  });

  it('ticks the ANSI status line while an active subagent is quiet', async () => {
    let now = 0;
    const output = outputBuffer();
    const timers = fakeTimers();
    const renderer = ansiRenderer(output, { nowMs: () => now, ...timers });

    await handleOrchestratorRootRun(renderer);
    now = 950;
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

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

    await handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);
    expect(timers.clearCount).toBe(1);
  });

  it('stops active-child heartbeat when preserving the live line', async () => {
    const output = outputBuffer();
    const timers = fakeTimers();
    const renderer = ansiRenderer(output, timers);

    await handleOrchestratorRootRun(renderer);
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    renderer.preserve();

    expect(timers.clearCount).toBe(1);
    expect(output.text.endsWith('\n')).toBe(true);
  });

  it('keeps the claimed root stream when a child run.config arrives later', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleOrchestratorRootRun(renderer);
    await handleConversationProgress(renderer, 'root-stream', {
      toolCallCount: 4,
    });
    await handleRoundStage(renderer, 'root-stream', { index: 1 });
    await handleRunConfig(renderer, {
      streamId: 'child-stream',
      agent: 'reviewer',
      inputFiles: ['chapter.tex'],
    });

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · tools: 4 · 0s\n' +
        '[r2] · orchestrator · tools: 4 · 0s\n',
    );
  });

  it('keeps named active children visible when earlier entries are unnamed', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleRunConfig(renderer);
    await handleActiveSubagents(renderer, 'stream-1', [
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

  it('joins a child description emitted before the active roster', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(
      renderer,
      'child-stream',
      'Check multiplier\nsigns\tand \x1b[2Jresonance counterexamples',
    );
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Check multiplier signs and resonance counterexa… · 0s\n',
    );
  });

  it('adds a description that arrives after the child becomes active', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    await handleStreamDescription(
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

  it('redacts secrets from child descriptions', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(
      renderer,
      'child-stream',
      'Run PASSWORD="correct horse" now',
    );
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Run PASSWORD=[redacted] now · 0s\n',
    );
  });

  it('keeps the current task across a same-turn manual retry', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(
      renderer,
      'child-stream',
      'Current review task',
    );
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    await handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.WAITING);
    await handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.RUNNING);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Current review task · 0s\n',
    );
  });

  it('prefers a running child over an earlier waiting child', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(
      renderer,
      'waiting-child',
      'Idle review task',
    );
    await handleStreamDescription(
      renderer,
      'running-child',
      'Active review task',
    );
    await handleActiveSubagents(renderer, 'root-stream', [
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

  it('fits the delegated task within an ANSI terminal row', async () => {
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { getColumns: () => 80 });

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(renderer, 'child-stream', 'A'.repeat(100));
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    const renderedLines = output.text.split('\r\x1b[2K').filter(Boolean);
    expect(renderedLines).toHaveLength(2);
    expect(renderedLines.at(-1)).toContain('subagent: review — ');
    expect(renderedLines.every((line) => textDisplayWidth(line) <= 80)).toBe(
      true,
    );
  });

  it('recalculates the delegated task width after a terminal resize', async () => {
    let columns = 100;
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { getColumns: () => columns });

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(renderer, 'child-stream', 'A'.repeat(100));
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    columns = 60;
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    const renderedLines = output.text.split('\r\x1b[2K').filter(Boolean);
    expect(renderedLines).toHaveLength(3);
    expect(textDisplayWidth(renderedLines.at(-1) ?? '')).toBeLessThanOrEqual(
      60,
    );
  });

  it('keeps the task description when an active child switches models', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(
      renderer,
      'child-stream',
      'Current review task',
    );
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    await handleRunConfig(renderer, {
      streamId: 'child-stream',
      agent: 'review',
    });
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Current review task · 0s\n',
    );
  });

  it('shows completed terminal stream stops with the shared cli wording', async () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = plainRenderer(output, {
      minIntervalMs: 0,
      nowMs: () => now,
    });

    await handleOrchestratorRootRun(renderer);
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    now = 11000;
    await handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.COMPLETED);
    await handleStreamDescription(
      renderer,
      'root-stream',
      'Running Mathematician multi-agent preset',
    );
    await handleRoundStage(renderer, 'root-stream', { index: 2 });
    await handleConversationProgress(renderer, 'root-stream', {
      toolCallCount: 9,
    });
    await handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        executionId: 'child-2',
        childStreamId: 'late-child-stream',
        agentName: 'late-review',
      }),
    ]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review · 0s\n' +
        'orchestrator · Completed · 11s\n',
    );
  });

  it('keeps cancelled terminal stream stops distinct from completion', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleOrchestratorRootRun(renderer);
    await handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);

    expect(output.text).toBe(
      'orchestrator · 0s\norchestrator · Stopped · 0s\n',
    );
  });

  it('does not repaint a child after the root stream is terminal', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleOrchestratorRootRun(renderer);
    await handleStreamDescription(renderer, 'child-stream', 'Late review task');
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    await handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.CANCELLED);
    await handleStreamStatus(renderer, 'child-stream', STREAM_PHASE.CANCELLED);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · subagent: review — Late review task · 0s\n' +
        'orchestrator · Stopped · 0s\n',
    );
  });

  it('freezes on a failed terminal stream stop, same as completed/cancelled', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleOrchestratorRootRun(renderer);
    await handleStreamStatus(renderer, 'root-stream', STREAM_PHASE.FAILED);
    // Post-terminal activity must not un-freeze the renderer (STREAM_PHASE.FAILED
    // must be recognized as a terminal outcome phase, same as COMPLETED/CANCELLED).
    await handleConversationProgress(renderer, 'root-stream', {
      toolCallCount: 9,
    });
    await handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        executionId: 'child-2',
        childStreamId: 'late-child-stream',
        agentName: 'late-review',
      }),
    ]);

    expect(output.text).toBe('orchestrator · 0s\norchestrator · Error · 0s\n');
  });

  it('uses a separate render flag from platform log suppression', async () => {
    expect(
      createRunProgressRenderer(
        context({ quietLogs: true, renderRunProgress: true }),
      ),
    ).toBeDefined();
    expect(
      createRunProgressRenderer(context({ renderRunProgress: false })),
    ).toBe(undefined);
  });

  it('derives the run progress flag from quiet and structured-output contexts', async () => {
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
      const session = createTestSession();
      const host = createCliRuntimeHost(
        context({
          quietLogs: true,
          renderRunProgress: true,
          stdoutColorEnabled: true,
          stderrColorEnabled: false,
        }),
      );
      const detach = host.attachRunProgressRenderer(session);
      // The session's graph is fresh: let its fold subscribe before the
      // facts land, so each fact paints as its own level.
      await settle();
      await publishRun(session, { streamId: 'gate-stream' });
      detach();
      await host.close();
    });

    expect(output).toContain('polish paper.tex · 0s');
    expect(output).not.toContain('\r\x1b[2K');
  });

  it('writes one status line when a run-scope status fact accompanies the session fact', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const session = createTestSession();
      const host = createCliRuntimeHost(
        context({
          stderrColorEnabled: false,
          quietLogs: true,
          renderRunProgress: true,
        }),
      );
      const detach = host.attachRunProgressRenderer(session);
      // The session's graph is fresh: let its fold subscribe before the
      // facts land, so each fact paints as its own level.
      await settle();

      await publishRun(session, { streamId: 'status-line-stream' });
      // Status travels only as a session fact (run-scope status is no longer
      // representable), so exactly one line renders for the transition.
      session.publishStatus({
        type: 'status',
        streamId: 'status-line-stream' as StreamTabId,
        phase: STREAM_PHASE.COMPLETED,
        cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
      });
      await settle();

      detach();
      await host.close();
    });

    // The committed launch batch paints with its inputs. Completion emits
    // exactly one further line.
    expect(output).toBe(
      'polish paper.tex · 0s\n' + 'polish paper.tex · Completed · 0s\n',
    );
  });

  it('preserves the live progress line before interactive prompts', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const session = createTestSession();
      const host = createCliRuntimeHost(
        context({
          approvalPolicy: 'ask',
          approvalPrompt: async () => 'n no review needed',
        }),
      );

      const detach = host.attachRunProgressRenderer(session);
      await publishRun(session, { streamId: 'prompt-stream' });
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
        const session = createTestSession();
        const host = createCliRuntimeHost(
          context({
            outputFormat: 'json',
            stderrColorEnabled: false,
            renderRunProgress: true,
          }),
        );
        const detach = host.attachRunProgressRenderer(session);
        await publishRun(session, { streamId: 'json-stream' });
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

  it('prints a visible agent-not-found error for showAgentConfigBanner in text mode', async () => {
    const output = await captureStreamWrites(process.stderr, async () => {
      const host = createCliRuntimeHost(context({ outputFormat: 'text' }));

      expect(
        host.emit('showAgentConfigBanner', {
          agentName: 'ghost',
          category: AgentCategory.ToolUse,
        }),
      ).toBe(true);

      await host.close();
    });

    expect(output).toContain('Agent not found: ghost');
    expect(output).toContain('texra agents list');
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
      const session = createTestSession();
      // The roster is the registry's, not the log's: the projection hears
      // it through `onChildActivity`, so the case plays the listener.
      let roster:
        | ((parentStreamId: StreamTabId, items: ActiveChildInfo[]) => void)
        | undefined;
      const detach = attachCliSessionProgressProjection({
        events: session.events,
        now: () => session.now(),
        executions: {
          onChildActivity: (listener) => {
            roster = listener;
            return () => {
              roster = undefined;
            };
          },
        },
      });
      roster?.('parent-stream' as StreamTabId, [
        {
          executionId: 'child-execution',
          childStreamId: 'child-stream',
          agentName: 'review',
          identity: { kind: 'agent' as const, agent: 'review' },
          status: 'running',
        },
      ]);
      await settle();
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

  it('maps the global quiet flag into CLI context args', async () => {
    expect(
      pickGlobalArgs(
        {
          quiet: true,
          'output-format': 'text',
          'approval-policy': 'never',
        },
        { skillSourcePaths: [] },
      ).quiet,
    ).toBe(true);
  });
});
