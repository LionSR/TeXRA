// Node imports
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

// Third-party imports
import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from 'effect';
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
  /** The runtime owner's close, as the package reaches it: by storage root. */
  closeSession: vi.fn((_root: string) => ({
    settled: true,
    abandoned: [] as string[],
  })),
  detachEvents: vi.fn(),
  disposeRuntime: vi.fn(async () => {}),
  executionId: 'execution-1',
  /** Fails the package session's fold, as a fold defect ends its view. */
  foldDeath: undefined as Deferred.Deferred<never, Error> | undefined,
  eventListener: undefined as ((event: unknown) => void) | undefined,
  initNodeAgentRuntime: vi.fn(),
  initPlatform: vi.fn(),
  initProcessWorkspaceRoots: vi.fn(),
  /** The process's session owner, as `installProcessRuntime` installs it
   *  and `disposeProcessRuntime` takes it away: what says whether the
   *  package must compose the process. */
  installRuntime: vi.fn(),
  ownerInstalled: false,
  loadAgents: vi.fn(),
  runValidatedAgent: vi.fn(),
  /** Every session the owner built for the package, with what it was
   *  built over: one per storage root. */
  sessionInits: [] as { readonly roots: { readonly storage: string } }[],
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
  /** The host a session was born with, per construction. */
  useInteractions: vi.fn(),
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
// The owner behind `openSession` is stood in for by a map keyed by storage
// root, as the runtime's `Sessions` map keys its entries: the package must
// resolve every run through it and never build a session of its own.
vi.mock('@agent/runtime', async () => {
  const { Deferred, Effect, Stream, SubscriptionRef } = await import('effect');
  const { emptySessionView } = await import('@shared/session/sessionView');
  class FakeSession {
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
            Deferred.await(mocks.foldDeath as Deferred.Deferred<never, Error>),
          ),
        ),
      ),
    );

    /** The transcript interest port, as the owner's graph exposes it. */
    readonly subscriptions = {
      set: (port: string, set: readonly unknown[]) =>
        Effect.sync(() => {
          mocks.setTranscriptSubscriptions(port, set);
        }),
    };

    readonly roots: { readonly storage: string };

    constructor(
      init: (typeof mocks.sessionInits)[number] & {
        readonly interactions?: unknown;
      },
    ) {
      mocks.sessionInits.push(init);
      mocks.sessionView = this.view;
      this.roots = init.roots;
      if (init.interactions) mocks.useInteractions(init.interactions);
    }
  }
  const sessions = new Map<string, FakeSession>();
  return {
    openSessionEffect: (init: ConstructorParameters<typeof FakeSession>[0]) =>
      Effect.sync(() => {
        let session = sessions.get(init.roots.storage);
        if (!session) {
          session = new FakeSession(init);
          sessions.set(init.roots.storage, session);
        }
        return session;
      }),
    listSessions: () => Effect.sync(() => [...sessions.values()]),
    closeSession: (root: string) =>
      Effect.sync(() => {
        sessions.delete(root);
        return mocks.closeSession(root);
      }),
    runAgent: mocks.runValidatedAgent,
    sessionOwnerInstalled: () => mocks.ownerInstalled,
  };
});

vi.mock('@controllers/session/sessionLayer', () => ({
  disposeProcessRuntime: mocks.disposeRuntime,
  installProcessRuntime: mocks.installRuntime,
}));

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
import { Runtime, Sessions } from '../../../packages/agent/src/effect';
import { nodePlatform } from '../../../packages/agent/src/node';

/** The embedder's shutdown path, as the package reads it: `shutdownRan`
 *  is what says a composition still has an owner to dispose it. */
const LIFECYCLE = { onShutdown: vi.fn(), shutdownRan: false };
const PLATFORM = {
  lifecycle: LIFECYCLE,
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
    // The package's session and runtime go on the embedder's shutdown path,
    // as the package registered it: each test starts with neither.
    await mocks.shutdownHooks?.flushArtifacts();
    for (const handler of mocks.shutdownHooks?.afterExecutionSettlement ?? []) {
      await handler();
    }
    mocks.shutdownHooks = undefined;
    LIFECYCLE.shutdownRan = false;
    mocks.sessionInits.splice(0);
    vi.clearAllMocks();
    mocks.activePlatform = null;
    mocks.agentCategory = 'toolUse';
    mocks.eventListener = undefined;
    mocks.ownerInstalled = false;
    mocks.initPlatform.mockImplementation((platform: object) => {
      mocks.activePlatform = platform;
    });
    mocks.installRuntime.mockImplementation(() => {
      mocks.ownerInstalled = true;
    });
    mocks.disposeRuntime.mockImplementation(async () => {
      mocks.ownerInstalled = false;
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
    // The refusal the package states from the input alone precedes the
    // composition: a caller being refused does not install a platform, a
    // process runtime or a session owner, and opens no session.
    expect(mocks.initPlatform).not.toHaveBeenCalled();
    expect(mocks.installRuntime).not.toHaveBeenCalled();
    expect(mocks.sessionInits).toHaveLength(0);
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

  it('resolves every run through the runtime session owner: two runs on one root share one session, closed through the owner before the runtime goes', async () => {
    const first = runAgent(INPUT);
    // The launch is the owner's before `runAgent` returns: a close or a
    // shutdown issued now finds this session, not an unopened root.
    expect(mocks.sessionInits).toHaveLength(1);
    await first.result;
    await runAgent(INPUT).result;

    // Both runs resolved the platform's root through the owner, which built
    // the session once, over the package's roots, born with the package's
    // one headless host; the second run found it open.
    expect(mocks.sessionInits).toHaveLength(1);
    expect(mocks.sessionInits[0]).toMatchObject({ roots: PLATFORM.roots });
    expect(mocks.useInteractions).toHaveBeenCalledOnce();
    expect(mocks.closeSession).not.toHaveBeenCalled();

    const hooks = mocks.shutdownHooks;
    expect(hooks).toBeDefined();
    await hooks?.flushArtifacts();
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(
      PLATFORM.roots.storage,
    );
    for (const handler of hooks?.afterExecutionSettlement ?? []) {
      await handler();
    }
    expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
    const [closeOrder] = mocks.closeSession.mock.invocationCallOrder;
    const [runtimeOrder] = mocks.disposeRuntime.mock.invocationCallOrder;
    expect(closeOrder).toBeLessThan(runtimeOrder);

    // Shutdown closed the session through its owner and took the owner with
    // the runtime it ran on. That path is the entry's only owner for a
    // composition and a lifecycle drains once, so a later run is refused
    // rather than composing a runtime and an owner nothing would dispose.
    LIFECYCLE.shutdownRan = true;
    await expect(runAgent(INPUT).result).rejects.toThrow(
      /shutdown has already run/,
    );
    expect(mocks.sessionInits).toHaveLength(1);
    expect(mocks.installRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.initPlatform).toHaveBeenCalledTimes(1);
  });

  it('composes into an embedder own runtime: the Effect surface starts a run and lists the one session the Promise entry already opened', async () => {
    // The Promise entry composes the process and opens the platform's root.
    await runAgent(INPUT).result;
    expect(mocks.sessionInits).toHaveLength(1);

    const program = Effect.gen(function* () {
      const sessions = yield* Sessions;
      const session = yield* sessions.open();
      const run = yield* session.start({
        agent: 'assistant',
        instruction: 'Test instruction',
      });
      const result = yield* run.result;
      const open = yield* sessions.list;
      return { open: open.length, result, streamId: run.streamId };
    }).pipe(Effect.scoped, Effect.provide(Runtime.layer(PLATFORM)));

    const seen = await Effect.runPromise(program);
    expect(seen.result).toBe(RESULT);
    expect(seen.streamId).toBe('stream-1');
    // One session per storage root, held by the runtime's own owner: the
    // Effect surface resolved the session the Promise entry ran on, and the
    // package built no registry of its own.
    expect(seen.open).toBe(1);
    expect(mocks.sessionInits).toHaveLength(1);
    // The scope composed nothing, so leaving it ended nothing the Promise
    // entry still uses: no close, no disposal, and the next run finds the
    // same session rather than building a second one.
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.disposeRuntime).not.toHaveBeenCalled();
    await runAgent(INPUT).result;
    expect(mocks.sessionInits).toHaveLength(1);
  });

  it('disposes the runtime its scope installed even when the closing session defects', async () => {
    // Nothing is composed yet, so this scope installs the runtime and owns
    // both the close and the disposal at its exit. The close defects on the
    // artifact flush: the disposal is its finalizer, not its continuation,
    // so the owner and the runtime under it still go, and the defect still
    // leaves the scope.
    mocks.closeSession.mockImplementationOnce(() => {
      throw new Error('artifact flush defect');
    });
    const program = Effect.gen(function* () {
      const sessions = yield* Sessions;
      yield* sessions.open();
    }).pipe(Effect.scoped, Effect.provide(Runtime.layer(PLATFORM)));

    await expect(Effect.runPromise(program)).rejects.toThrow(
      'artifact flush defect',
    );
    expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
  });

  it('holds the runtime for an overlapping scope: the composing scope leaving closes nothing', async () => {
    // Two independently provided scopes over one platform. The first
    // composes the process; the second finds that composition and borrows
    // it. The first leaving must not close the session the second is still
    // working on, nor dispose the runtime under it.
    const firstComposed = Effect.runSync(Deferred.make<void>());
    const secondComposed = Effect.runSync(Deferred.make<void>());
    const secondMayLeave = Effect.runSync(Deferred.make<void>());

    const first = Effect.runFork(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        yield* sessions.open();
        yield* Deferred.succeed(firstComposed, undefined);
        yield* Deferred.await(secondComposed);
      }).pipe(Effect.scoped, Effect.provide(Runtime.layer(PLATFORM))),
    );
    await Effect.runPromise(Deferred.await(firstComposed));

    const second = Effect.runFork(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        yield* sessions.open();
        yield* Deferred.succeed(secondComposed, undefined);
        yield* Deferred.await(secondMayLeave);
      }).pipe(Effect.scoped, Effect.provide(Runtime.layer(PLATFORM))),
    );
    await Effect.runPromise(Deferred.await(secondComposed));

    await Effect.runPromise(Fiber.join(first));
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.disposeRuntime).not.toHaveBeenCalled();

    await Effect.runPromise(Deferred.succeed(secondMayLeave, undefined));
    await Effect.runPromise(Fiber.join(second));
    // The last hold out is what ends the composition the two shared.
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(
      PLATFORM.roots.storage,
    );
    expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
  });

  it('closes every root the owner holds before it disposes the runtime', async () => {
    const otherRoots = { storage: '/other-storage' };
    const program = Effect.gen(function* () {
      const sessions = yield* Sessions;
      yield* sessions.open();
      yield* sessions.open(otherRoots as never);
    }).pipe(Effect.scoped, Effect.provide(Runtime.layer(PLATFORM)));

    await Effect.runPromise(program);

    // A root this composition opened of its own settles and flushes like
    // the runtime's, rather than going down with the runtime unwritten.
    expect(mocks.closeSession.mock.calls.map(([root]) => root)).toEqual([
      PLATFORM.roots.storage,
      otherRoots.storage,
    ]);
    const [disposal] = mocks.disposeRuntime.mock.invocationCallOrder;
    for (const order of mocks.closeSession.mock.invocationCallOrder) {
      expect(order).toBeLessThan(disposal as number);
    }
  });

  it('a scoped reader holds its own transcript interest and clears it at the scope, leaving the run its own', async () => {
    await runAgent(INPUT).result;
    const interest = [{ id: 'stream-1', fromSeq: 0 }];

    const program = Effect.gen(function* () {
      const sessions = yield* Sessions;
      const session = yield* sessions.open();
      yield* Effect.scoped(session.subscribe(interest as never));
    }).pipe(Effect.scoped, Effect.provide(Runtime.layer(PLATFORM)));
    await Effect.runPromise(program);

    const ports = mocks.setTranscriptSubscriptions.mock.calls as [
      string,
      readonly unknown[],
    ][];
    const reader = ports.filter(([port]) => port.startsWith('sdk/reader/'));
    // The reader's own port: set for the scope, emptied when it closed.
    expect(reader).toHaveLength(2);
    expect(reader[0]?.[1]).toEqual(interest);
    expect(reader[1]?.[0]).toBe(reader[0]?.[0]);
    expect(reader[1]?.[1]).toEqual([]);
    // The run's port is the run's: the reader never touched it, so the
    // README's residency contract still holds for a finished run.
    expect(ports.filter(([port]) => port === 'sdk/stream-1')).toEqual([
      ['sdk/stream-1', interest],
    ]);
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
