// Node imports
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import {
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  onTestFinished,
  vi,
} from 'vitest';

interface RunAgentOptions {
  readonly onRun?: (handle: unknown) => void | Promise<void>;
  readonly onStreamResolved?: (streamId: string, trace: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  activePlatform: null as object | null,
  agentCategory: 'toolUse',
  detachEvents: vi.fn(),
  detachInteractions: vi.fn(),
  disposeSession: vi.fn(),
  executionId: 'execution-1',
  interruptClaudeAgentSessions: vi.fn(),
  interruptCodexThreads: vi.fn(),
  killBackgroundProcesses: vi.fn(),
  eventListener: undefined as ((event: unknown) => void) | undefined,
  initNodeAgentRuntime: vi.fn(),
  initPlatform: vi.fn(),
  initProcessWorkspaceRoots: vi.fn(),
  loadAgents: vi.fn(),
  runValidatedAgent: vi.fn(),
  subscribe: vi.fn((listener: (event: unknown) => void) => {
    mocks.eventListener = listener;
    return mocks.detachEvents;
  }),
  useInteractions: vi.fn(() => mocks.detachInteractions),
  warn: vi.fn(),
}));

vi.mock('@agent/core/definition/AgentConfig', () => ({
  AgentConfigSchema: { parse: (value: unknown) => value },
}));

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return {
    ...actual,
    createLog: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mocks.warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('@agent/index', () => ({
  loadAgents: mocks.loadAgents,
  resolveAgent: () => ({
    entry: {
      category: mocks.agentCategory,
      source: 'custom',
      name: 'assistant',
    },
  }),
}));

// The package reaches the runtime through the curated `@agent/runtime` barrel,
// so the suite mocks that one door instead of each runtime module by path.
vi.mock('@agent/runtime', async () => {
  const { Effect, SubscriptionRef } = await import('effect');
  const { emptySessionView } = await import('@shared/session/sessionView');
  return {
    SessionHandle: class {
      readonly executions = {
        killBackgroundProcesses: mocks.killBackgroundProcesses,
      };

      readonly interactions = { use: mocks.useInteractions };
      /** The session's view level, holding the run's one stream. */
      readonly view = Effect.runSync(
        SubscriptionRef.make({
          ...emptySessionView('package'),
          streams: new Map([['stream-1', { executionId: mocks.executionId }]]),
        }),
      );

      dispose = mocks.disposeSession;
    },
    runAgent: mocks.runValidatedAgent,
    processOwnerId: (processStart: string) => `${process.pid}:${processStart}`,
  };
});

vi.mock('@tools/agentCliSessionStores', () => ({
  claudeAgentSessionsFor: (session: unknown) => ({
    interruptAll: () => mocks.interruptClaudeAgentSessions(session),
  }),
  codexThreadsFor: (session: unknown) => ({
    interruptAll: () => mocks.interruptCodexThreads(session),
  }),
}));

vi.mock('@platform/defaults/nodeAgentRuntime', () => ({
  initNodeAgentRuntime: mocks.initNodeAgentRuntime,
}));

vi.mock('@platform/platform', () => ({
  initPlatform: mocks.initPlatform,
  tryPlatform: () => mocks.activePlatform,
}));

vi.mock('@platform/workspaceRoots', () => ({
  initProcessWorkspaceRoots: mocks.initProcessWorkspaceRoots,
}));

vi.mock('@transcript/StreamLogStore', () => ({
  StreamLogStore: { ephemeral: () => ({}) },
}));

// Local imports - package API under test
import {
  runAgent,
  type AgentPlatform,
  type HostInteractionCancelSelector,
  type PendingInteractionKind,
  type SessionView,
} from '../../../packages/agent/src/index';
import { nodePlatform } from '../../../packages/agent/src/node';

const PLATFORM = {
  lifecycle: { onShutdown: vi.fn() },
  roots: {},
  processes: { selfIdentity: async () => 'test-start' },
} as unknown as AgentPlatform;
/** The run's trace as `onStreamResolved` hands it over: the event source. */
const TRACE = { subscribe: mocks.subscribe };
/** The run's handle as `onRun` hands it over: the interrupt target. */
const HANDLE = { executionId: mocks.executionId, interrupt: vi.fn() };
const RESULT = { outcome: 'COMPLETED' } as never;
const EVENT = { type: 'run.start' } as never;
const INPUT = {
  agent: 'assistant',
  instruction: 'Test instruction',
  interactions: { cancel: vi.fn() },
  platform: PLATFORM,
};

describe('agent package run lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activePlatform = null;
    mocks.agentCategory = 'toolUse';
    mocks.eventListener = undefined;
    mocks.initPlatform.mockImplementation((platform: object) => {
      mocks.activePlatform = platform;
    });
    mocks.loadAgents.mockResolvedValue(undefined);
    mocks.runValidatedAgent.mockImplementation(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        await options.onRun?.(HANDLE);
        return RESULT;
      },
    );
  });

  it('exports cancellation selector types from the package entry point', () => {
    expectTypeOf<{
      kind: 'planApproval';
    }>().toMatchTypeOf<HostInteractionCancelSelector>();
    expectTypeOf<'planApproval'>().toMatchTypeOf<PendingInteractionKind>();
  });

  it('initializes standard runtime features once for concurrent first runs', async () => {
    await Promise.all([runAgent(INPUT).result, runAgent(INPUT).result]);

    expect(mocks.initPlatform).toHaveBeenCalledWith(PLATFORM);
    expect(mocks.initPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.initNodeAgentRuntime).toHaveBeenCalledWith(PLATFORM.lifecycle);
    expect(mocks.initNodeAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it('delivers the launch events: the trace is subscribed when the stream resolves, before the run handle exists', async () => {
    mocks.runValidatedAgent.mockImplementationOnce(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        // The instruction log, the root stage, and the launch warnings fire
        // here, before `onRun`.
        mocks.eventListener?.(EVENT);
        await options.onRun?.(HANDLE);
        return RESULT;
      },
    );

    const run = runAgent(INPUT);
    const nextEvent = run[Symbol.asyncIterator]().next();

    await expect(nextEvent).resolves.toEqual({ done: false, value: EVENT });
    await run.result;
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it('discards trace events when the caller only awaits the result', async () => {
    mocks.runValidatedAgent.mockImplementationOnce(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        await options.onRun?.(HANDLE);
        mocks.eventListener?.(EVENT);
        return RESULT;
      },
    );

    const run = runAgent(INPUT);
    await run.result;

    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(mocks.detachEvents).toHaveBeenCalledOnce();
    await expect(run[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('rejects caller tools that require unavailable approval', async () => {
    const run = runAgent({
      ...INPUT,
      tools: [
        {
          definition: { name: 'dangerous_tool' },
          requiresApproval: true,
        },
      ] as never,
    });

    await expect(run.result).rejects.toThrow(
      'The agent package cannot run approval-requiring tools: dangerous_tool',
    );
    expect(mocks.runValidatedAgent).not.toHaveBeenCalled();
  });

  it('rejects custom tools for workflow agents', async () => {
    mocks.agentCategory = 'workflow';
    const run = runAgent({
      ...INPUT,
      tools: [
        {
          definition: { name: 'custom_reader' },
          requiresApproval: false,
        },
      ] as never,
    });

    await expect(run.result).rejects.toThrow(
      'Custom tools are supported only for tool-use agents; "assistant" is a workflow agent.',
    );
    expect(mocks.runValidatedAgent).not.toHaveBeenCalled();
  });

  it('stops the run session background children before disposing it', async () => {
    await runAgent(INPUT).result;

    expect(mocks.killBackgroundProcesses).toHaveBeenCalledOnce();
    // Session-keyed registries: interruption is scoped by the per-run session
    // handed to the accessor, not by an ownedBy filter argument.
    expect(mocks.interruptCodexThreads).toHaveBeenCalledOnce();
    expect(mocks.interruptClaudeAgentSessions).toHaveBeenCalledOnce();
    expect(mocks.interruptCodexThreads.mock.calls[0]?.[0]).toMatchObject({
      dispose: mocks.disposeSession,
    });
    const [killOrder] = mocks.killBackgroundProcesses.mock.invocationCallOrder;
    const [disposeOrder] = mocks.disposeSession.mock.invocationCallOrder;
    expect(killOrder).toBeLessThan(disposeOrder);
  });

  it('still disposes the session when the background drain fails', async () => {
    const killError = new Error('kill failed');
    mocks.killBackgroundProcesses.mockImplementationOnce(() => {
      throw killError;
    });

    await expect(runAgent(INPUT).result).resolves.toBe(RESULT);
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to stop package background processes',
      { data: killError },
    );
    expect(mocks.disposeSession).toHaveBeenCalledOnce();
  });

  it('preserves the run result when session disposal fails', async () => {
    const disposalError = new Error('session disposal failed');
    mocks.disposeSession.mockImplementationOnce(() => {
      throw disposalError;
    });

    await expect(runAgent(INPUT).result).resolves.toBe(RESULT);
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to dispose package session',
      {
        data: disposalError,
      },
    );
  });

  it('preserves the run failure when session disposal also fails', async () => {
    const runError = new Error('run failed');
    const disposalError = new Error('session disposal failed');
    mocks.runValidatedAgent.mockRejectedValueOnce(runError);
    mocks.disposeSession.mockImplementationOnce(() => {
      throw disposalError;
    });

    await expect(runAgent(INPUT).result).rejects.toBe(runError);
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to dispose package session',
      {
        data: disposalError,
      },
    );
  });

  it('detaches the event source when iteration ends early', async () => {
    let finishRun: ((result: typeof RESULT) => void) | undefined;
    mocks.runValidatedAgent.mockImplementationOnce(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        await options.onRun?.(HANDLE);
        return await new Promise<typeof RESULT>((resolve) => {
          finishRun = resolve;
        });
      },
    );

    const run = runAgent(INPUT);
    const iterator = run[Symbol.asyncIterator]();
    const nextEvent = iterator.next();
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    mocks.eventListener?.(EVENT);

    await expect(nextEvent).resolves.toEqual({ done: false, value: EVENT });
    await iterator.return?.();
    expect(mocks.detachEvents).toHaveBeenCalledOnce();

    finishRun?.(RESULT);
    await expect(run.result).resolves.toBe(RESULT);
  });

  it('reads the session view: `view` replays the level holding the run, then ends when the run settles', async () => {
    let finishRun: ((result: typeof RESULT) => void) | undefined;
    mocks.runValidatedAgent.mockImplementationOnce(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        await options.onRun?.(HANDLE);
        return await new Promise<typeof RESULT>((resolve) => {
          finishRun = resolve;
        });
      },
    );

    const run = runAgent(INPUT);
    const views = run.view[Symbol.asyncIterator]();
    const view = (await views.next()).value as SessionView;
    expect(
      [...view.streams.values()].map((stream) => stream.executionId),
    ).toContain(HANDLE.executionId);

    finishRun?.(RESULT);
    await expect(views.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(run.result).resolves.toBe(RESULT);
  });
});

describe('agent package Node configuration', () => {
  it('treats bare and prefixed configuration keys as equivalent', async () => {
    // The roots pin the workspace storage path at construction, so the
    // storage root must be a real directory.
    const storageDir = await mkdtemp(join(tmpdir(), 'texra-agent-package-'));
    onTestFinished(() => rm(storageDir, { recursive: true, force: true }));
    const { config } = nodePlatform({
      agentsDir: '/agents',
      storageDir,
      workspaceDir: '/workspace',
    }).roots;

    await config.update('texra.goal.enabled', true, 'global');
    expect(config.get('goal.enabled')).toBe(true);
    expect(config.inspect('goal.enabled')?.globalValue).toBe(true);
    expect(config.isExplicitlySet('goal.enabled')).toBe(true);

    await config.update('goal.enabled', undefined, 'global');
    // With no explicit value, resolution matches every host: the core-schema
    // default (goal.enabled defaults to true) wins over the caller fallback.
    expect(config.get('texra.goal.enabled', false)).toBe(true);
    // A key outside the core schema still falls back to the caller default.
    expect(config.get('custom.nonCoreKey', false)).toBe(false);
    expect(config.isExplicitlySet('texra.goal.enabled')).toBe(false);
  });
});
