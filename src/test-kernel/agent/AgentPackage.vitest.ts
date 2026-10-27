// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Stream, SubscriptionRef } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports - package API under test
import { MemoryStateStore } from '@platform/defaults/memoryState';
import type { RunId } from '@shared/schemas';
import {
  emptySessionView,
  type SessionView as RuntimeSessionView,
} from '@shared/session/sessionView';
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeSessions } from '../../../packages/harness/src/effect/sessionPrograms';
import type { AgentPlatform } from '../../../packages/harness/src/index';

interface RootLaunchOptions {
  readonly onRun?: (handle: unknown) => Effect.Effect<void>;
  readonly onAdmitted?: (runId: string) => Effect.Effect<void, Error>;
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

const RUN_ID = 'ae0001';

/**
 * The runtime session the package opens, as the process's session owner
 * serves it: its run completes, but its final view never folds, and its
 * view's level stream ends as the fold does (`foldDeath`).
 */
class FakeSession {
  readonly viewRef = Effect.runSync(
    SubscriptionRef.make<FakeSessionView>({
      ...emptySessionView('package'),
      runs: new Map(),
    }),
  );
  // The package launches through its session's runs: a root launch.
  readonly runs = {
    get: () => undefined,
    interrupt: () => false,
    launch: ({ options }: { readonly options: RootLaunchOptions }) =>
      Effect.gen({ self: this }, function* () {
        yield* options.onAdmitted?.(RUN_ID) ?? Effect.void;
        yield* SubscriptionRef.update(this.viewRef, (current) => ({
          ...current,
          runs: new Map(current.runs).set(RUN_ID, {
            id: RUN_ID,
            ancestors: [],
            childIds: [],
            durableOutcome: null,
          }),
        }));
        yield* options.onRun?.({ runId: RUN_ID, interrupt: vi.fn() }) ??
          Effect.void;
        return { outcome: 'COMPLETED' } as never;
      }).pipe(Effect.uninterruptible),
  };
  readonly interactions = {
    approvalPromptsUnavailable: false,
    emit: () => Effect.void,
    use: () => Effect.succeed(() => undefined),
  };
  readonly requests = { request: () => Effect.succeed({ kind: 'done' }) };
  readonly log = { movedAside: null, settled: Effect.void };
  readonly trace = { listen: () => () => undefined };
  readonly followUps = { resumes: { joined: () => false } };
  readonly view = {
    ref: this.viewRef,
    changes: Stream.merge(
      SubscriptionRef.changes(this.viewRef),
      Stream.fromEffect(Effect.suspend(() => Deferred.await(this.foldDeath))),
    ),
    subscribe: () => Effect.void,
    inputs: () => Stream.empty,
  };

  readonly roots: { readonly storage: string };
  readonly foldDeath: Deferred.Deferred<never, Error>;

  constructor(
    roots: { readonly storage: string },
    foldDeath: Deferred.Deferred<never, Error>,
  ) {
    this.roots = roots;
    this.foldDeath = foldDeath;
  }
}

describe('agent package sessions', () => {
  beforeEach(async () => {
    // Every named agent resolves to a custom `assistant` in the kernel
    // runtime's catalog, which this suite never loads.
    const { AgentCatalog } = await import('@agent/index/agentCatalog');
    const catalog = testRuntime().runSync(
      Effect.gen(function* () {
        return yield* AgentCatalog;
      }),
    );
    vi.spyOn(catalog, 'get').mockReturnValue({
      source: 'custom',
      name: 'assistant',
    } as ReturnType<typeof catalog.get>);
  });

  it.live(
    'fails the run instead of hanging when the session fold dies before the final view',
    () =>
      // The run completes, but its final view never folds: the fold dies
      // first, and both the run's view and its result fail with that death
      // rather than wait on a level that never comes.
      Effect.gen(function* () {
        const foldDeath = yield* Deferred.make<never, Error>();
        const owner = {
          open: (init: { readonly roots: { readonly storage: string } }) =>
            Effect.succeed(new FakeSession(init.roots, foldDeath)),
        };
        const sessions = yield* makeSessions(
          owner as never,
          yield* testRuntime().contextEffect,
          yield* Effect.scope,
        );
        const session = yield* sessions.open({
          storage: '/storage',
          globalState: new MemoryStateStore(),
        } as unknown as AgentPlatform['roots']);
        const run = yield* session.start({
          agent: 'assistant',
          instruction: 'Test instruction',
          runId: RUN_ID as RunId,
        });
        const pull = yield* Stream.toPull(run.view);
        yield* pull;
        yield* Deferred.fail(foldDeath, new Error('fold died'));

        const exits: Exit.Exit<unknown, unknown>[] = [
          yield* Effect.exit(pull),
          yield* Effect.exit(run.result),
        ];
        for (const exit of exits) {
          expect(
            Exit.isFailure(exit) && Cause.squash(exit.cause),
          ).toMatchObject({ message: 'fold died' });
        }
      }).pipe(Effect.scoped),
  );
});
