// Node imports
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Stream,
  SubscriptionRef,
} from 'effect';
import { beforeEach, describe, expect, onTestFinished, vi } from 'vitest';

interface RunAgentOptions {
  readonly onRun?: (handle: unknown) => Effect.Effect<void>;
  readonly onRunResolved?: (runId: string, trace: unknown) => void;
}

/** A session view run entry as the package's fold keys it. */
interface FakeRunView {
  readonly id: string;
  readonly ancestors: readonly { readonly id: string }[];
  readonly childIds: readonly string[];
  readonly durableOutcome: 'completed' | null;
}
type FakeSessionView = Omit<RuntimeSessionView, 'runs'> & {
  readonly runs: Map<string, FakeRunView>;
};

const mocks = vi.hoisted(() => ({
  /** The runtime owner's close, as the package reaches it: by storage root. */
  /** The session's one request door, as a decision reaches it. */
  decide: vi.fn((_request: unknown) => Effect.succeed({ kind: 'done' })),
  closeSession: vi.fn((_root: string) =>
    Effect.succeed({ settled: true, abandoned: [] as string[] }),
  ),
  detachEvents: vi.fn(),
  /** The process layer's release, as the package's scope ends it. */
  releaseProcess: vi.fn(),
  runId: 'ae0001',
  /** Fails the package session's fold, as a fold defect ends its view. */
  foldDeath: undefined as Deferred.Deferred<never, Error> | undefined,
  eventListener: undefined as ((event: unknown) => void) | undefined,
  /** What the package composes its process from (`processLayer`). */
  processLayer: vi.fn(),
  runValidatedAgent: vi.fn(),
  interruptRun: vi.fn(),
  /** Every session the owner built for the package, with what it was
   *  built over: one per storage root. */
  sessionInits: [] as {
    readonly roots: { readonly storage: string };
    readonly interactions?: { readonly approvalPromptsUnavailable?: boolean };
  }[],
  /** The current package session's view, advanced independently of run. */
  sessionView: undefined as unknown,
  setTranscriptSubscriptions: vi.fn(),
  subscribe: vi.fn((listener: (event: unknown) => void) => {
    mocks.eventListener = listener;
    return mocks.detachEvents;
  }),
}));

vi.mock('@agent/core/definition/AgentConfig', () => ({
  AgentConfigSchema: { parse: (value: unknown) => value },
}));

// The package mints the run's one id before it launches, and keys the run's
// transcript port and view lookups on it: pinning it here is what lets the
// suite name the run it started.
vi.mock('@utils/core', async (importActual) => ({
  ...(await importActual<typeof import('@utils/core')>()),
  generateRunId: () => mocks.runId,
}));

vi.mock('@agent/index/agentRegistry', async (importActual) => ({
  ...(await importActual<typeof import('@agent/index/agentRegistry')>()),
  getAgent: () => ({
    source: 'custom',
    name: 'assistant',
  }),
}));

// The package launches through the curated `@agent/runtime` barrel.
vi.mock('@agent/runtime/runAgent', async () => {
  const { Effect } = await import('effect');
  return {
    runAgent: (input: unknown, options: RunAgentOptions) =>
      Effect.tryPromise({
        try: () => mocks.runValidatedAgent(input, options),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(Effect.uninterruptible),
  };
});

// The package composes its process with `processLayer`. The owner it serves
// is stood in for by a map keyed by storage root, as the runtime's session
// map keys its entries: the package must resolve every run through it and
// never build a session of its own. The other process services are the
// kernel runtime's.
vi.mock('@controllers/session/sessionLayer', async () => {
  const { Context, Deferred, Effect, Layer, Stream, SubscriptionRef } =
    await import('effect');
  const { SessionOwner } = await import('@platform/processRuntime');
  const { testRuntime } = await import('@test/support/testProcessRuntime');
  const { emptySessionView } = await import('@shared/session/sessionView');
  class FakeSession {
    readonly runs = {
      interrupt: mocks.interruptRun,
    };
    readonly interactions: { readonly approvalPromptsUnavailable?: boolean };
    readonly requests = { request: mocks.decide };
    /** The session's view level: the pre-launch session, no run yet. */
    readonly viewRef = Effect.runSync(
      SubscriptionRef.make<FakeSessionView>({
        ...emptySessionView('package'),
        runs: new Map(),
      }),
    );

    readonly view = {
      ref: this.viewRef,
      /** The level stream, ending as the fold does (`SessionViewService`);
       *  the fold's fate is the test's. */
      changes: Stream.unwrap(
        Effect.sync(() =>
          Stream.merge(
            SubscriptionRef.changes(this.viewRef),
            Stream.fromEffect(
              Deferred.await(
                mocks.foldDeath as Deferred.Deferred<never, Error>,
              ),
            ),
          ),
        ),
      ),
      /** The transcript interest port. */
      subscribe: (port: string, set: readonly unknown[]) =>
        Effect.sync(() => {
          mocks.setTranscriptSubscriptions(port, set);
        }),
    };

    readonly roots: { readonly storage: string };

    constructor(init: (typeof mocks.sessionInits)[number]) {
      mocks.sessionInits.push(init);
      mocks.sessionView = this.viewRef;
      this.roots = init.roots;
      this.interactions = init.interactions ?? {};
    }
  }
  const sessions = new Map<string, FakeSession>();
  const closeSession = (root: string) =>
    Effect.sync(() => {
      sessions.delete(root);
    }).pipe(Effect.andThen(() => mocks.closeSession(root)));
  const owner = {
    open: (init: ConstructorParameters<typeof FakeSession>[0]) =>
      Effect.sync(() => {
        let session = sessions.get(init.roots.storage);
        if (!session) {
          session = new FakeSession(init);
          sessions.set(init.roots.storage, session);
        }
        return session;
      }),
    list: Effect.sync(() => [...sessions.values()]),
    close: closeSession,
    closeAll: Effect.suspend(() =>
      Effect.forEach([...sessions.keys()], (root) => closeSession(root), {
        concurrency: 'unbounded',
      }),
    ),
  };
  return {
    processLayer: (options: unknown) => {
      mocks.processLayer(options);
      return Layer.effectContext(
        Effect.map(testRuntime().contextEffect, (context) =>
          Context.add(context, SessionOwner, owner as never),
        ),
      ).pipe(
        Layer.merge(
          Layer.effectDiscard(
            Effect.addFinalizer(() =>
              Effect.sync(() => mocks.releaseProcess()),
            ),
          ),
        ),
      );
    },
  };
});

// Local imports - package API under test
import { MemoryStateStore } from '@platform/defaults/memoryState';
import type { RunId } from '@shared/schemas';
import type { SessionView as RuntimeSessionView } from '@shared/session/sessionView';
import type { Plugin } from '@tools/plugins';
import {
  aggregateId,
  type AgentPlatform,
  Sessions,
} from '../../../packages/harness/src/index';
import { nodePlatform } from '../../../packages/harness/src/node';

/** The plugin list every composition below is made with. */
const PLUGINS: readonly Plugin[] = [];

const PLATFORM = {
  globalState: { get: () => undefined, update: async () => undefined },
  roots: { storage: '/storage', globalState: new MemoryStateStore() },
  storage: { getGlobalStoragePath: () => '/global-storage' },
} as unknown as AgentPlatform;
/** The run's trace as `onRunResolved` hands it over: the event source. */
const TRACE = { subscribe: mocks.subscribe };
/** The run's handle as `onRun` hands it over: the interrupt target. */
const HANDLE = { runId: mocks.runId, interrupt: vi.fn() };
const RESULT = { outcome: 'COMPLETED' } as never;

function sessionView(): SubscriptionRef.SubscriptionRef<FakeSessionView> {
  return mocks.sessionView as SubscriptionRef.SubscriptionRef<FakeSessionView>;
}

/** Fold one run into the session view, as its `run.start` would: the
 *  fold keeps `childIds` and `ancestors` in sync, so entering a run with
 *  ancestors also links it onto its immediate parent's `childIds`. */
function enterRun(id: string, run: Partial<FakeRunView> = {}): Promise<void> {
  const ancestors = run.ancestors ?? [];
  const parentId = ancestors.at(-1)?.id;
  return Effect.runPromise(
    SubscriptionRef.update(sessionView(), (current) => {
      const runs = new Map(current.runs).set(id, {
        id,
        ancestors: [],
        childIds: [],
        durableOutcome: null,
        ...run,
      });
      const parent = parentId === undefined ? undefined : runs.get(parentId);
      if (parentId !== undefined && parent) {
        runs.set(parentId, {
          ...parent,
          childIds: [...parent.childIds, id],
        });
      }
      return { ...current, runs };
    }),
  );
}

/** Publish the final folded view separately from the run result. */
function completeRunView(): Promise<void> {
  return Effect.runPromise(
    SubscriptionRef.update(sessionView(), (current) => ({
      ...current,
      runs: new Map(
        [...current.runs].map(([id, run]) => [
          id,
          { ...run, durableOutcome: 'completed' as const },
        ]),
      ),
    })),
  );
}

/** The run entering the session, then its final view folding. */
async function driveRun(options: RunAgentOptions): Promise<typeof RESULT> {
  options.onRunResolved?.('ae0001', TRACE);
  await enterRun('ae0001');
  await Effect.runPromise(options.onRun?.(HANDLE) ?? Effect.void);
  await completeRunView();
  return RESULT;
}

/** Runs the run's own lifecycle hook, as the host invokes it. */
async function runOnRun(options: RunAgentOptions): Promise<void> {
  await Effect.runPromise(options.onRun?.(HANDLE) ?? Effect.void);
}

describe('agent package sessions', () => {
  beforeEach(() => {
    mocks.sessionInits.splice(0);
    vi.clearAllMocks();
    mocks.eventListener = undefined;
    mocks.foldDeath = Effect.runSync(Deferred.make<never, Error>());
    mocks.interruptRun.mockReturnValue(false);
    mocks.runValidatedAgent.mockImplementation(
      (_input: unknown, options: RunAgentOptions) => driveRun(options),
    );
  });

  it.live(
    'aborts interrupted admission before waiting for the provider cleanup',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const aborted = yield* Deferred.make<void>();
        let finishCleanup!: () => void;
        const cleanupMayFinish = new Promise<void>((resolve) => {
          finishCleanup = resolve;
        });
        const observations: string[] = [];
        mocks.runValidatedAgent.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            // The native run's fiber is its stop, by run id, from the
            // instant it is admitted: interruption reaches it while the
            // hand-off is masked.
            mocks.interruptRun.mockImplementation(() => {
              observations.push('aborted');
              Deferred.doneUnsafe(aborted, Effect.void);
              resolve();
              return true;
            });
            Deferred.doneUnsafe(entered, Effect.void);
          });
          await cleanupMayFinish;
          observations.push('settled');
          return RESULT;
        });
        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const session = yield* sessions.open();
          const admission = yield* Effect.forkChild(
            session.start({
              agent: 'assistant',
              instruction: 'Test instruction',
            }),
          );
          yield* Deferred.await(entered);
          const interruption = yield* Effect.forkChild(
            Fiber.interrupt(admission),
          );
          yield* Deferred.await(aborted);
          expect(observations).toEqual(['aborted']);
          expect(interruption.pollUnsafe()).toBeUndefined();
          expect(mocks.interruptRun).toHaveBeenCalledWith(expect.any(String));
          finishCleanup();
          yield* Fiber.join(interruption);
          expect(observations).toEqual(['aborted', 'settled']);
          const exit = yield* Fiber.await(admission);
          expect(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          ).toBe(true);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Sessions.layer({ platform: PLATFORM, plugins: PLUGINS }),
          ),
        );
      }),
  );

  it.effect('denies a request whose approval handler throws', () =>
    Effect.gen(function* () {
      const decided = yield* Deferred.make<unknown>();
      mocks.decide.mockImplementationOnce((request: unknown) =>
        Deferred.succeed(decided, request).pipe(Effect.as({ kind: 'done' })),
      );
      const sessions = yield* Sessions;
      yield* sessions.open(undefined, {
        approve: () => {
          throw new Error('handler down');
        },
      });
      yield* Effect.promise(() =>
        enterRun('ae0001', { approval: 'own' } as Partial<FakeRunView>),
      );
      yield* SubscriptionRef.update(sessionView(), (current) => ({
        ...current,
        requests: [
          {
            runId: 'ae0001' as RunId,
            requestId: 'r1',
            payload: { kind: 'bash', data: {} } as never,
            thread: null,
          },
        ],
      }));
      expect(yield* Deferred.await(decided)).toEqual({
        kind: 'request.decide',
        runId: 'ae0001',
        requestId: 'r1',
        decision: {
          action: 'deny',
          reason: 'The approval handler gave no decision: handler down',
        },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Sessions.layer({ platform: PLATFORM, plugins: PLUGINS })),
    ),
  );

  it.live("serves the embedder's tool-missing handler", () =>
    Effect.gen(function* () {
      const openOnce = (platform: AgentPlatform) =>
        Effect.flatMap(Sessions, (sessions) => sessions.open()).pipe(
          Effect.scoped,
          Effect.provide(Sessions.layer({ platform, plugins: PLUGINS })),
        );
      const toolMissingHandler = vi.fn();
      yield* openOnce({ ...PLATFORM, toolMissingHandler });
      expect(mocks.processLayer).toHaveBeenCalledWith(
        expect.objectContaining({ toolMissingReporter: toolMissingHandler }),
      );
      // The process lives for the layer's scope.
      expect(mocks.releaseProcess).toHaveBeenCalledOnce();
    }),
  );

  it.live(
    'a scoped reader holds its own transcript interest and clears it at the scope, leaving the run its own',
    () =>
      Effect.gen(function* () {
        const interest = [
          { id: aggregateId('run', 'ae0001' as RunId), fromSeq: 0 },
        ];

        const program = Effect.gen(function* () {
          const sessions = yield* Sessions;
          const session = yield* sessions.open();
          yield* session.start({
            agent: 'assistant',
            instruction: 'Test instruction',
          });
          yield* Effect.scoped(session.subscribe(interest));
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Sessions.layer({ platform: PLATFORM, plugins: PLUGINS }),
          ),
        );
        yield* program;

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
        expect(ports.filter(([port]) => port === 'sdk/ae0001')).toEqual([
          ['sdk/ae0001', interest],
        ]);
      }),
  );

  it.live(
    'fails the run instead of hanging when the session fold dies before the final view',
    () =>
      Effect.gen(function* () {
        // The run completes, but its final view never folds: the fold dies
        // first, and both the run's view and its result fail with that death
        // rather than wait on a level that never comes.
        mocks.runValidatedAgent.mockImplementationOnce(
          async (_input: unknown, options: RunAgentOptions) => {
            options.onRunResolved?.('ae0001', TRACE);
            await enterRun('ae0001');
            await runOnRun(options);
            return RESULT;
          },
        );

        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const session = yield* sessions.open();
          const run = yield* session.start({
            agent: 'assistant',
            instruction: 'Test instruction',
          });
          const pull = yield* Stream.toPull(run.view);
          yield* pull;
          yield* Deferred.fail(
            mocks.foldDeath as Deferred.Deferred<never, Error>,
            new Error('fold died'),
          );

          const viewExit = yield* Effect.exit(pull);
          expect(Exit.isFailure(viewExit)).toBe(true);
          if (Exit.isFailure(viewExit)) {
            const failure = Cause.squash(viewExit.cause);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toBe('fold died');
          }
          const resultExit = yield* Effect.exit(run.result);
          expect(Exit.isFailure(resultExit)).toBe(true);
          if (Exit.isFailure(resultExit)) {
            const failure = Cause.squash(resultExit.cause);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toBe('fold died');
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Sessions.layer({ platform: PLATFORM, plugins: PLUGINS }),
          ),
        );
      }),
  );
});

describe('agent package Node configuration', () => {
  it.effect('treats bare and prefixed configuration keys as equivalent', () =>
    Effect.gen(function* () {
      // The roots pin the workspace storage path at construction, so the
      // storage root must be a real directory.
      const storageDir = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), 'texra-agent-package-')),
      );
      onTestFinished(() => rm(storageDir, { recursive: true, force: true }));
      const { config } = nodePlatform({
        agentsDir: '/agents',
        storageDir,
        workspaceDir: '/workspace',
      }).roots;

      yield* config.update('texra.agentOutputs.autoOpenFinal', true, 'global');
      expect(config.get('agentOutputs.autoOpenFinal')).toBe(true);
      expect(config.inspect('agentOutputs.autoOpenFinal')?.globalValue).toBe(
        true,
      );

      yield* config.update('agentOutputs.autoOpenFinal', undefined, 'global');
      // With no explicit value, resolution matches every host: the core-schema
      // default (true) wins over the caller fallback.
      expect(config.get('texra.agentOutputs.autoOpenFinal', false)).toBe(true);
      // A key outside the core schema still falls back to the caller default.
      expect(config.get('custom.nonCoreKey', false)).toBe(false);
      expect(
        config.inspect('texra.agentOutputs.autoOpenFinal')?.globalValue,
      ).toBeUndefined();
    }),
  );
});
