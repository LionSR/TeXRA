// Third-party imports
import { it } from '@effect/vitest';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Stream,
  SubscriptionRef,
} from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports - package API under test
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  emptySessionView,
  type SessionView as RuntimeSessionView,
} from '@shared/session/sessionView';
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeSessions } from '../../../packages/harness/src/effect/sessionPrograms';
import type { TranscriptSubscription } from '@texra-ai/harness/transcript';
import type { RunId } from '@texra-ai/harness/schemas';
import type { AgentPlatform } from '../../../packages/harness/src/index';

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
 * serves it: its run opens at commit 0, but its final view never folds, its
 * view's level stream ends as the fold does (`foldDeath`), and its log
 * settles only past the fold, so it dies with it.
 */
class FakeSession {
  readonly viewRef = Effect.runSync(
    SubscriptionRef.make<FakeSessionView>({
      ...emptySessionView('package'),
      runs: new Map(),
    }),
  );
  // The package launches through its session's runs: a root launch, which
  // answers the commit of the run's opening.
  readonly runs = {
    get: () => undefined,
    launch: () =>
      SubscriptionRef.update(this.viewRef, (current) => ({
        ...current,
        runs: new Map(current.runs).set(RUN_ID, {
          id: RUN_ID,
          ancestors: [],
          childIds: [],
          durableOutcome: null,
        }),
      })).pipe(Effect.as(0)),
  };
  readonly interactions = {
    approvalPromptsUnavailable: false,
    emit: () => Effect.void,
    use: () => Effect.succeed(() => undefined),
  };
  readonly requests = { request: () => Effect.succeed({ kind: 'done' }) };
  readonly log = {
    movedAside: null,
    tail: () => Stream.empty,
    settled: Effect.suspend(() => Deferred.await(this.foldDeath)).pipe(
      Effect.orDie,
    ),
  };
  readonly view = {
    ref: this.viewRef,
    changes: Stream.merge(
      SubscriptionRef.changes(this.viewRef),
      Stream.fromEffect(Effect.suspend(() => Deferred.await(this.foldDeath))),
    ),
    // A subscription's replay lands as a level holding its transcripts.
    subscribe: (_port: string, set: readonly TranscriptSubscription[]) =>
      SubscriptionRef.update(this.viewRef, (current) => ({
        ...current,
        transcriptSeq: new Map(set.map(({ id }) => [id, 0])),
      })),
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

/**
 * A session whose run's previous activation completed, as a same-session
 * resume meets it: the view still holds that outcome when the launch opens
 * the run at commit 1, and the new activation folds once the test's reader
 * has read that level. The start's own check reads no run, so the launch
 * seeds the old outcome.
 */
class RelaunchedSession extends FakeSession {
  readonly readers = Effect.runSync(Queue.unbounded<void>());
  override readonly view: FakeSession['view'] = {
    ...this.view,
    changes: this.view.changes.pipe(
      Stream.tap(() => Queue.offer(this.readers, undefined)),
    ),
  };
  override readonly runs: FakeSession['runs'] = {
    ...this.runs,
    launch: () =>
      Effect.gen({ self: this }, function* () {
        yield* this.fold(0, 'completed');
        yield* Effect.forkDetach(
          Queue.take(this.readers).pipe(
            Effect.andThen(this.fold(1, null)),
            Effect.andThen(this.fold(2, 'completed')),
          ),
        );
        return 1;
      }),
  };

  constructor(foldDeath: Deferred.Deferred<never, Error>) {
    super({ storage: '/storage' }, foldDeath);
  }

  /** The level at `cursor`, the run's durable outcome `outcome`. */
  fold(cursor: number, outcome: FakeRunView['durableOutcome']) {
    return SubscriptionRef.update(this.viewRef, (current) => ({
      ...current,
      cursor,
      runs: new Map(current.runs).set(RUN_ID, {
        id: RUN_ID,
        ancestors: [],
        childIds: [],
        durableOutcome: outcome,
      }),
    }));
  }
}

/** The package's session over `fake`, as the process's owner opens it. */
const openPackageSession = (fake: FakeSession) =>
  Effect.gen(function* () {
    const sessions = yield* makeSessions(
      { open: () => Effect.succeed(fake) } as never,
      yield* testRuntime().contextEffect,
    );
    return yield* sessions.open({
      storage: '/storage',
      globalState: new MemoryStateStore(),
    } as unknown as AgentPlatform['roots']);
  });

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
        const session = yield* openPackageSession(
          new FakeSession({ storage: '/storage' }, foldDeath),
        );
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

  it.live(
    "ends a relaunched run's view at its own activation's outcome, not the one before",
    () =>
      Effect.gen(function* () {
        const fake = new RelaunchedSession(
          yield* Deferred.make<never, Error>(),
        );
        const session = yield* openPackageSession(fake);
        const run = yield* session.start({
          agent: 'assistant',
          instruction: 'Test instruction',
          runId: RUN_ID as RunId,
        });
        const levels = yield* Effect.forkChild(Stream.runCollect(run.view));

        expect(
          (yield* Fiber.join(levels)).map((level) => [
            level.cursor,
            level.runs.get(RUN_ID as RunId)?.durableOutcome,
          ]),
        ).toEqual([
          [1, null],
          [2, 'completed'],
        ]);
      }).pipe(Effect.scoped),
  );
});
