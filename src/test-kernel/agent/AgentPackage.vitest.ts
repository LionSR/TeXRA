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
import { TestClock } from 'effect/testing';
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
  agentCategory: 'toolUse',
  /** The runtime owner's close, as the package reaches it: by storage root. */
  closeSession: vi.fn((_root: string) =>
    Effect.succeed({ settled: true, abandoned: [] as string[] }),
  ),
  detachEvents: vi.fn(),
  disposeRuntime: vi.fn(() => Effect.void),
  runId: 'ae0001',
  /** Fails the package session's fold, as a fold defect ends its view. */
  foldDeath: undefined as Deferred.Deferred<never, Error> | undefined,
  eventListener: undefined as ((event: unknown) => void) | undefined,
  /** The process's session owner, as `installProcessRuntime` installs it
   *  and `disposeProcessRuntime` takes it away, carrying the runtime it runs
   *  on: what says whether the package must compose the process. */
  installRuntime: vi.fn(),
  ownerRuntime: undefined as ProcessRuntime | undefined,
  loadAgents: vi.fn(),
  runValidatedAgent: vi.fn(),
  interruptRun: vi.fn(),
  /** Every session the owner built for the package, with what it was
   *  built over: one per storage root. */
  sessionInits: [] as { readonly roots: { readonly storage: string } }[],
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

vi.mock('@agent/index', () => ({
  loadAgents: mocks.loadAgents,
  getAgent: () => ({
    category: mocks.agentCategory,
    source: 'custom',
    name: 'assistant',
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
    readonly runs = {
      interrupt: mocks.interruptRun,
    };
    /** The session's view level: the pre-launch session, no run yet. */
    readonly view = Effect.runSync(
      SubscriptionRef.make<FakeSessionView>({
        ...emptySessionView('package'),
        runs: new Map(),
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

    constructor(init: (typeof mocks.sessionInits)[number]) {
      mocks.sessionInits.push(init);
      mocks.sessionView = this.view;
      this.roots = init.roots;
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
      }).pipe(Effect.andThen(() => mocks.closeSession(root))),
    runAgent: (input: unknown, options: RunAgentOptions) =>
      Effect.tryPromise({
        try: () => mocks.runValidatedAgent(input, options),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(Effect.uninterruptible),
    installedProcessRuntime: () => mocks.ownerRuntime,
  };
});

vi.mock('@controllers/session/sessionLayer', async () => {
  const { Effect: effect } = await import('effect');
  return {
    // The double records when the disposal runs, not when the composition
    // builds it: `disposeProcessRuntime` answers a program now.
    disposeProcessRuntime: () => effect.suspend(() => mocks.disposeRuntime()),
    installProcessRuntime: mocks.installRuntime,
  };
});

// Local imports - package API under test
import { SHUTDOWN_PHASE_DEADLINE_MS } from '@platform/defaults/lifecycleHost';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import type { SessionView as RuntimeSessionView } from '@shared/session/sessionView';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  aggregateId,
  type AgentPlatform,
  PlatformConflict,
  Sessions,
} from '../../../packages/agent/src/index';
import { nodePlatform } from '../../../packages/agent/src/node';

const PLATFORM = {
  lifecycle: { onShutdown: vi.fn(), shutdownRan: false },
  globalState: { get: () => undefined, update: async () => undefined },
  roots: { storage: '/storage' },
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
    mocks.agentCategory = 'toolUse';
    mocks.eventListener = undefined;
    mocks.ownerRuntime = undefined;
    mocks.installRuntime.mockImplementation(() => {
      mocks.ownerRuntime = testRuntime();
      return mocks.ownerRuntime;
    });
    mocks.disposeRuntime.mockImplementation(() =>
      Effect.sync(() => {
        mocks.ownerRuntime = undefined;
      }),
    );
    mocks.foldDeath = Effect.runSync(Deferred.make<never, Error>());
    mocks.loadAgents.mockReturnValue(Effect.void);
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
        }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM)));
      }),
  );

  it.live(
    'disposes the runtime its scope installed even when the closing session defects',
    () =>
      Effect.gen(function* () {
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
        }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM)));

        const exit = yield* Effect.exit(program);
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        if (Exit.isFailure(exit)) {
          const defect = Cause.squash(exit.cause);
          expect(defect).toBeInstanceOf(Error);
          expect((defect as Error).message).toBe('artifact flush defect');
        }
        expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
      }),
  );

  it.live(
    'holds the runtime for an overlapping scope: the composing scope leaving closes nothing',
    () =>
      Effect.gen(function* () {
        // Two independently provided scopes over one platform. The first
        // composes the process; the second finds that composition and borrows
        // it. The first leaving must not close the session the second is still
        // working on, nor dispose the runtime under it.
        const firstComposed = yield* Deferred.make<void>();
        const secondComposed = yield* Deferred.make<void>();
        const secondMayLeave = yield* Deferred.make<void>();

        const first = yield* Effect.forkChild(
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* sessions.open();
            yield* Deferred.succeed(firstComposed, undefined);
            yield* Deferred.await(secondComposed);
          }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM))),
        );
        yield* Deferred.await(firstComposed);

        const second = yield* Effect.forkChild(
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* sessions.open();
            yield* Deferred.succeed(secondComposed, undefined);
            yield* Deferred.await(secondMayLeave);
          }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM))),
        );
        yield* Deferred.await(secondComposed);

        yield* Fiber.join(first);
        expect(mocks.closeSession).not.toHaveBeenCalled();
        expect(mocks.disposeRuntime).not.toHaveBeenCalled();

        yield* Deferred.succeed(secondMayLeave, undefined);
        yield* Fiber.join(second);
        // The last hold out is what ends the composition the two shared.
        expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(
          PLATFORM.roots.storage,
        );
        expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'waits for the retiring runtime before admitting another scope',
    () =>
      Effect.gen(function* () {
        const closing = yield* Deferred.make<void>();
        const closeMayFinish = yield* Deferred.make<void>();
        const retiring = yield* Deferred.make<void>();
        const retirementMayFinish = yield* Deferred.make<void>();
        const successorEntered = yield* Deferred.make<void>();
        const successorMayLeave = yield* Deferred.make<void>();
        mocks.closeSession.mockImplementationOnce(() =>
          Deferred.succeed(closing, undefined).pipe(
            Effect.andThen(Deferred.await(closeMayFinish)),
            Effect.as({ settled: true, abandoned: [] as string[] }),
          ),
        );
        mocks.disposeRuntime.mockImplementationOnce(() =>
          Effect.sync(() => {
            // Disposal uninstalls the owner before unwinding the runtime.
            mocks.ownerRuntime = undefined;
          }).pipe(
            Effect.andThen(Deferred.succeed(retiring, undefined)),
            Effect.andThen(Deferred.await(retirementMayFinish)),
          ),
        );
        yield* Effect.gen(function* () {
          const first = yield* Effect.forkChild(
            Effect.flatMap(Sessions, (sessions) => sessions.open()).pipe(
              Effect.provide(Sessions.layer(PLATFORM)),
            ),
          );
          yield* Deferred.await(closing);
          const successor = yield* Effect.forkChild(
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              yield* sessions.open();
              yield* Deferred.succeed(successorEntered, undefined);
              yield* Deferred.await(successorMayLeave);
            }).pipe(Effect.provide(Sessions.layer(PLATFORM))),
            { startImmediately: true },
          );
          expect(yield* Deferred.isDone(successorEntered)).toBe(false);
          yield* Deferred.succeed(closeMayFinish, undefined);
          yield* Deferred.await(retiring);
          expect(mocks.ownerRuntime).toBeUndefined();
          expect(yield* Deferred.isDone(successorEntered)).toBe(false);
          expect(mocks.installRuntime).toHaveBeenCalledOnce();
          yield* Deferred.succeed(retirementMayFinish, undefined);
          yield* Fiber.join(first);
          yield* Deferred.await(successorEntered);
          expect(mocks.installRuntime).toHaveBeenCalledTimes(2);
          expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
          yield* Deferred.succeed(successorMayLeave, undefined);
          yield* Fiber.join(successor);
          expect(mocks.disposeRuntime).toHaveBeenCalledTimes(2);
        }).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(closeMayFinish, undefined),
              Deferred.succeed(retirementMayFinish, undefined),
              Deferred.succeed(successorMayLeave, undefined),
            ]),
          ),
        );
      }),
  );

  it.live(
    'closes every root the owner holds before it disposes the runtime',
    () =>
      Effect.gen(function* () {
        const otherRoots = { storage: '/other-storage' };
        const program = Effect.gen(function* () {
          const sessions = yield* Sessions;
          yield* sessions.open();
          yield* sessions.open(otherRoots as never);
        }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM)));

        yield* program;

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
      }),
  );

  it.effect(
    'settles every root it closes under one shutdown deadline, not one each (#12804)',
    () =>
      Effect.gen(function* () {
        // Each close spends its whole budget, as a close with a run still
        // live past it does.
        const spendBudget = () =>
          Effect.sleep(SHUTDOWN_PHASE_DEADLINE_MS).pipe(
            Effect.as({ settled: false, abandoned: [] as string[] }),
          );
        mocks.closeSession
          .mockImplementationOnce(spendBudget)
          .mockImplementationOnce(spendBudget);
        const released = yield* Effect.forkChild(
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* sessions.open();
            yield* sessions.open({ storage: '/other-storage' } as never);
          }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM))),
        );

        yield* TestClock.adjust(`${SHUTDOWN_PHASE_DEADLINE_MS} millis`);

        expect(released.pollUnsafe()).toBeDefined();
        expect(mocks.closeSession).toHaveBeenCalledTimes(2);
        expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
      }),
  );

  it.live(
    "serves the embedder's tool-missing handler and refuses a runtime it did not compose",
    () =>
      Effect.gen(function* () {
        const openOnce = (platform: AgentPlatform) =>
          Effect.flatMap(Sessions, (sessions) => sessions.open()).pipe(
            Effect.scoped,
            Effect.provide(Sessions.layer(platform)),
          );
        const toolMissingHandler = vi.fn();
        yield* openOnce({ ...PLATFORM, toolMissingHandler });
        expect(mocks.installRuntime).toHaveBeenCalledWith(
          expect.objectContaining({ toolMissingReporter: toolMissingHandler }),
        );

        // A runtime a host installed for its own roots is not the package's
        // to borrow, even once every hold of its own has ended.
        mocks.ownerRuntime = testRuntime();
        const exit = yield* Effect.exit(openOnce(PLATFORM));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(PlatformConflict);
        }
        expect(mocks.installRuntime).toHaveBeenCalledOnce();
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
        }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM)));
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
        }).pipe(Effect.scoped, Effect.provide(Sessions.layer(PLATFORM)));
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

      yield* config.update('texra.goal.enabled', true, 'global');
      expect(config.get('goal.enabled')).toBe(true);
      expect(config.inspect('goal.enabled')?.globalValue).toBe(true);

      yield* config.update('goal.enabled', undefined, 'global');
      // With no explicit value, resolution matches every host: the core-schema
      // default (goal.enabled defaults to true) wins over the caller fallback.
      expect(config.get('texra.goal.enabled', false)).toBe(true);
      // A key outside the core schema still falls back to the caller default.
      expect(config.get('custom.nonCoreKey', false)).toBe(false);
      expect(config.inspect('texra.goal.enabled')?.globalValue).toBeUndefined();
    }),
  );
});
