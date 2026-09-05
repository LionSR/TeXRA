// Node imports
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

// Third-party imports
import { Deferred, Effect, Stream, SubscriptionRef } from 'effect';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

interface RunAgentOptions {
  readonly onRun?: (handle: unknown) => void | Promise<void>;
  readonly onStreamResolved?: (streamId: string, trace: unknown) => void;
}

/** A session view stream entry as the package's fold keys it. */
interface FakeStreamView {
  readonly id: string;
  readonly executionId: string;
  readonly ancestors: readonly { readonly id: string }[];
  readonly durableOutcome: 'completed' | null;
}
type FakeSessionView = Omit<RuntimeSessionView, 'streams'> & {
  readonly streams: Map<string, FakeStreamView>;
};

const mocks = vi.hoisted(() => ({
  activePlatform: null as object | null,
  agentCategory: 'toolUse',
  detachEvents: vi.fn(),
  detachInteractions: vi.fn(),
  disposeRuntime: vi.fn(),
  disposeSession: vi.fn(),
  executionId: 'execution-1',
  flushArtifacts: vi.fn(async () => {}),
  /** Fails the package session's fold, as a fold defect ends its view. */
  foldDeath: undefined as Deferred.Deferred<never, Error> | undefined,
  eventListener: undefined as ((event: unknown) => void) | undefined,
  initNodeAgentRuntime: vi.fn(),
  initPlatform: vi.fn(),
  initProcessWorkspaceRoots: vi.fn(),
  loadAgents: vi.fn(),
  runValidatedAgent: vi.fn(),
  /** Every package session construction, with what it was built over. */
  sessionInits: [] as unknown[],
  /** The current package session's view, advanced independently of execution. */
  sessionView: undefined as unknown,
  setTranscriptSubscriptions: vi.fn(),
  /** What the package registered on the embedder's shutdown path. */
  shutdownHooks: undefined as
    | {
        readonly flushArtifacts: () => void | Promise<void>;
        readonly afterExecutionSettlement?: readonly (() => unknown)[];
      }
    | undefined,
  subscribe: vi.fn((listener: (event: unknown) => void) => {
    mocks.eventListener = listener;
    return mocks.detachEvents;
  }),
  useInteractions: vi.fn(() => mocks.detachInteractions),
}));

vi.mock('@agent/core/definition/AgentConfig', () => ({
  AgentConfigSchema: { parse: (value: unknown) => value },
}));

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
  const { Deferred, Effect, Stream, SubscriptionRef } = await import('effect');
  const { emptySessionView } = await import('@shared/session/sessionView');
  return {
    SessionHandle: class {
      readonly interactions = { use: mocks.useInteractions };
      /** The session's view level: the pre-launch session, no stream yet. */
      readonly view = Effect.runSync(
        SubscriptionRef.make<FakeSessionView>({
          ...emptySessionView('package'),
          streams: new Map(),
        }),
      );

      /** The level stream, ending as the fold does (`SessionViewService`);
       *  the fold's fate is the test's. */
      readonly viewChanges = Stream.unwrap(
        Effect.sync(() =>
          Stream.merge(
            SubscriptionRef.changes(this.view),
            Stream.fromEffect(
              Deferred.await(
                mocks.foldDeath as Deferred.Deferred<never, Error>,
              ),
            ),
          ),
        ),
      );

      readonly setTranscriptSubscriptions = mocks.setTranscriptSubscriptions;
      readonly flushArtifacts = mocks.flushArtifacts;
      dispose = mocks.disposeSession;

      constructor(init: unknown) {
        mocks.sessionInits.push(init);
        mocks.sessionView = this.view;
      }
    },
    runAgent: mocks.runValidatedAgent,
  };
});

vi.mock('@controllers/session/sessionLayer', () => ({
  installProcessRuntime: () => ({ dispose: mocks.disposeRuntime }),
}));

vi.mock('@platform/processRuntime', async () => {
  const { Effect } = await import('effect');
  return {
    effectRuntime: () => ({
      runFork: Effect.runFork,
      runPromise: Effect.runPromise,
    }),
  };
});

vi.mock('@tools/agentCliSessionStores', () => ({
  registerRuntimeShutdownHandlers: (
    _lifecycle: unknown,
    hooks: typeof mocks.shutdownHooks,
  ) => {
    mocks.shutdownHooks = hooks;
  },
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
import type { SessionView as RuntimeSessionView } from '@shared/session/sessionView';
import {
  runAgent,
  type AgentPlatform,
  type SessionView,
} from '../../../packages/agent/src/index';
import { nodePlatform } from '../../../packages/agent/src/node';

const PLATFORM = {
  lifecycle: { onShutdown: vi.fn() },
  roots: { storage: '/storage' },
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
  platform: PLATFORM,
};

function sessionView(): SubscriptionRef.SubscriptionRef<FakeSessionView> {
  return mocks.sessionView as SubscriptionRef.SubscriptionRef<FakeSessionView>;
}

/** Fold one stream into the session view, as its `run.start` would. */
function enterStream(
  id: string,
  stream: Partial<FakeStreamView> = {},
): Promise<void> {
  return Effect.runPromise(
    SubscriptionRef.update(sessionView(), (current) => ({
      ...current,
      streams: new Map(current.streams).set(id, {
        id,
        executionId: mocks.executionId,
        ancestors: [],
        durableOutcome: null,
        ...stream,
      }),
    })),
  );
}

/** Publish the final folded view separately from the execution result. */
function completeRunView(): Promise<void> {
  return Effect.runPromise(
    SubscriptionRef.update(sessionView(), (current) => ({
      ...current,
      streams: new Map(
        [...current.streams].map(([id, stream]) => [
          id,
          { ...stream, durableOutcome: 'completed' as const },
        ]),
      ),
    })),
  );
}

/** The run's stream entering the session, then its final view folding. */
async function driveRun(options: RunAgentOptions): Promise<typeof RESULT> {
  options.onStreamResolved?.('stream-1', TRACE);
  await enterStream('stream-1');
  await options.onRun?.(HANDLE);
  await completeRunView();
  return RESULT;
}

describe('agent package run lifecycle', () => {
  beforeEach(async () => {
    // The package's sessions go with its runtime on the embedder's shutdown
    // path, as the package registered it: each test starts with none.
    for (const handler of mocks.shutdownHooks?.afterExecutionSettlement ?? []) {
      await handler();
    }
    mocks.shutdownHooks = undefined;
    mocks.sessionInits.splice(0);
    vi.clearAllMocks();
    mocks.activePlatform = null;
    mocks.agentCategory = 'toolUse';
    mocks.eventListener = undefined;
    mocks.initPlatform.mockImplementation((platform: object) => {
      mocks.activePlatform = platform;
    });
    mocks.foldDeath = Effect.runSync(Deferred.make<never, Error>());
    mocks.loadAgents.mockResolvedValue(undefined);
    mocks.runValidatedAgent.mockImplementation(
      (_input: unknown, options: RunAgentOptions) => driveRun(options),
    );
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
        await enterStream('stream-1');
        await options.onRun?.(HANDLE);
        await completeRunView();
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
        await enterStream('stream-1');
        await options.onRun?.(HANDLE);
        mocks.eventListener?.(EVENT);
        await completeRunView();
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
    await expect(run.view[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
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
    await expect(run.view[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('shares one session per storage root across runs and disposes it before the runtime on shutdown', async () => {
    await runAgent(INPUT).result;
    await runAgent(INPUT).result;

    // Both runs folded into the one session over the platform's roots, the
    // first run's: the graph `Sessions` keys by storage root and the
    // transcript store it bridges are then the same for every run on that
    // root.
    expect(mocks.sessionInits).toHaveLength(1);
    expect(mocks.sessionInits[0]).toMatchObject({ roots: PLATFORM.roots });
    expect(mocks.disposeSession).not.toHaveBeenCalled();

    const hooks = mocks.shutdownHooks;
    expect(hooks).toBeDefined();
    await hooks?.flushArtifacts();
    expect(mocks.flushArtifacts).toHaveBeenCalledOnce();
    for (const handler of hooks?.afterExecutionSettlement ?? []) {
      await handler();
    }
    expect(mocks.disposeSession).toHaveBeenCalledOnce();
    expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
    const [disposeOrder] = mocks.disposeSession.mock.invocationCallOrder;
    const [runtimeOrder] = mocks.disposeRuntime.mock.invocationCallOrder;
    expect(disposeOrder).toBeLessThan(runtimeOrder);

    // Shutdown took the package's sessions down with their owner: a later
    // call finds none and builds the package state anew. Whether such a run
    // works is out of contract (the README scopes the session to the
    // process); only the reset owner is observed here.
    await runAgent(INPUT).result;
    expect(mocks.sessionInits).toHaveLength(2);
  });

  it('fails the run instead of hanging when the session fold dies before the final view', async () => {
    mocks.runValidatedAgent.mockImplementationOnce(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        await enterStream('stream-1');
        await options.onRun?.(HANDLE);
        return RESULT;
      },
    );

    const run = runAgent(INPUT);
    const views = run.view[Symbol.asyncIterator]();
    await views.next();
    const failed = expect(run.result).rejects.toThrow('fold died');
    await Effect.runPromise(
      Deferred.fail(
        mocks.foldDeath as Deferred.Deferred<never, Error>,
        new Error('fold died'),
      ),
    );

    await expect(views.next()).rejects.toThrow('fold died');
    await failed;
  });

  it('detaches the event source when iteration ends early', async () => {
    let finishRun: ((result: typeof RESULT) => void) | undefined;
    mocks.runValidatedAgent.mockImplementationOnce(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        await enterStream('stream-1');
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

    const views = run.view[Symbol.asyncIterator]();
    await views.next();
    await views.return?.();
    expect(HANDLE.interrupt).not.toHaveBeenCalled();

    await completeRunView();
    finishRun?.(RESULT);
    await expect(run.result).resolves.toBe(RESULT);
  });

  it('reads the session view: `view` skips the levels before the run, subscribes its transcript, then ends with the view holding its durable outcome', async () => {
    let finishRun: ((result: typeof RESULT) => void) | undefined;
    let enterRun: (() => void) | undefined;
    mocks.runValidatedAgent.mockImplementationOnce(
      async (_input: unknown, options: RunAgentOptions) => {
        options.onStreamResolved?.('stream-1', TRACE);
        // The fold lands the run's `run.start` asynchronously: the session's
        // current level predates the run until this resolves.
        await new Promise<void>((resolve) => {
          enterRun = resolve;
        });
        await enterStream('stream-1');
        await options.onRun?.(HANDLE);
        return await new Promise<typeof RESULT>((resolve) => {
          finishRun = resolve;
        });
      },
    );

    const run = runAgent(INPUT);
    const views = run.view[Symbol.asyncIterator]();
    const first = views.next();
    await vi.waitFor(() => expect(enterRun).toBeDefined());
    // The run's stream is subscribed as soon as it exists in the session.
    expect(mocks.setTranscriptSubscriptions).toHaveBeenCalledWith(
      'sdk/stream-1',
      [{ id: 'stream-1', fromSeq: 0 }],
    );
    enterRun?.();
    const view = (await first).value as SessionView;
    expect(
      [...view.streams.values()].map((stream) => stream.executionId),
    ).toContain(HANDLE.executionId);

    // A descendant joining the view joins the run's subscription.
    await enterStream('stream-2', { ancestors: [{ id: 'stream-1' }] });
    await views.next();
    await vi.waitFor(() =>
      expect(mocks.setTranscriptSubscriptions).toHaveBeenLastCalledWith(
        'sdk/stream-1',
        [
          { id: 'stream-1', fromSeq: 0 },
          { id: 'stream-2', fromSeq: 0 },
        ],
      ),
    );

    // Execution can finish before the final view folds. The run's result
    // waits for that fold, even while the consumer is between reads.
    finishRun?.(RESULT);
    await setImmediate();
    let settled = false;
    void run.result.then(() => {
      settled = true;
    });
    await setImmediate();
    expect(settled).toBe(false);

    await completeRunView();
    const last = (await views.next()).value as SessionView;
    expect(last.streams.get('stream-1')?.durableOutcome).toBe('completed');
    await expect(views.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(run.result).resolves.toBe(RESULT);

    // A reader attaching after settlement receives the final state once.
    const lateViews = run.view[Symbol.asyncIterator]();
    await expect(lateViews.next()).resolves.toEqual({
      done: false,
      value: last,
    });
    await expect(lateViews.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
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
