import '@test/support/sessionGraphTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Stream,
  SubscriptionRef,
} from 'effect';
import { describe, expect } from 'vitest';

// Local imports - package API under test
import { SessionRequests } from '@agent/runtime/requestPolicy';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import {
  emptySessionView,
  type SessionView as RuntimeSessionView,
} from '@shared/session/sessionView';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import {
  closeTestSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { REAL_RUN_TIMEOUT, validationHost } from '@test/support/storeFaults';
import {
  testRuntime,
  testSessionOwner,
} from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { makeSessions } from '../../../packages/harness/src/effect/sessionPrograms';
import { runView } from '../../../packages/harness/src/effect/runHandle';
import type { TranscriptSubscription } from '@texra-ai/harness/transcript';
import type { RunId } from '@texra-ai/harness/schemas';

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
  readonly runs = { get: () => undefined };
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

  /** The run's opening as a root launch commits it: the commit it answers. */
  open(): Effect.Effect<number> {
    return SubscriptionRef.update(this.viewRef, (current) => ({
      ...current,
      runs: new Map(current.runs).set(RUN_ID, {
        id: RUN_ID,
        ancestors: [],
        childIds: [],
        durableOutcome: null,
      }),
    })).pipe(Effect.as(0));
  }
}

/**
 * A session whose run's previous activation completed, as a same-session
 * resume meets it: the view still holds that outcome when the launch opens
 * the run at commit 1, and the new activation folds once the test's reader
 * has read that level. The opening seeds the old outcome.
 */
class RelaunchedSession extends FakeSession {
  readonly readers = Effect.runSync(Queue.unbounded<void>());
  override readonly view: FakeSession['view'] = {
    ...this.view,
    changes: this.view.changes.pipe(
      Stream.tap(() => Queue.offer(this.readers, undefined)),
    ),
  };
  override open(): Effect.Effect<number> {
    return Effect.gen({ self: this }, function* () {
      yield* this.fold(0, 'completed');
      yield* Effect.forkDetach(
        Queue.take(this.readers).pipe(
          Effect.andThen(this.fold(1, null)),
          Effect.andThen(this.fold(2, 'completed')),
        ),
      );
      return 1;
    });
  }

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

/** The package's handle on `fake`'s run, from the activation its opening
 *  commits, as `session.start` gives it. */
const startedRun = (fake: FakeSession) =>
  Effect.map(fake.open(), (activation) =>
    runView(contextOf(fake), RUN_ID as RunId, activation),
  );

/** `fake` as the session's owners a run's view reads. */
const contextOf = (fake: FakeSession) =>
  // cast: the fake carries only what a run's view reads of each owner.
  Context.make(SessionLog, fake.log as never).pipe(
    Context.add(SessionViewAccess, fake.view as never),
    Context.add(Runs, fake.runs as never),
    Context.add(SessionRequests, fake.requests as never),
  ) as never;

describe('agent package sessions', () => {
  it.live(
    'fails the run instead of hanging when the session fold dies before the final view',
    () =>
      // The run completes, but its final view never folds: the fold dies
      // first, and both the run's view and its result fail with that death
      // rather than wait on a level that never comes.
      Effect.gen(function* () {
        const foldDeath = yield* Deferred.make<never, Error>();
        const run = yield* startedRun(
          new FakeSession({ storage: '/storage' }, foldDeath),
        );
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
        const run = yield* startedRun(fake);
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

/** `session` as the package hands it to an embedder (`Sessions.open`),
 *  launching under the test process's session owner. */
const packageSession = (session: Context.Context<SessionServices>) =>
  Effect.gen(function* () {
    const owner = yield* testSessionOwner;
    const sessions = yield* makeSessions(
      { ...owner, open: () => Effect.succeed(session) },
      yield* testRuntime().contextEffect,
    );
    return yield* sessions.open(testWorkspaceRoots());
  });

describe(
  'agent package sessions over a real store',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    validationHost('texra-package-');

    it.live(
      "R19: a root run a model error ends reads as a failed RunEnd with the error's kind, not a RunFailure",
      () =>
        Effect.gen(function* () {
          const roots = testWorkspaceRoots();
          // No host answers: the session an embedder opens by default.
          const sdk = yield* packageSession(
            yield* openTestDefaultSession({
              roots,
              interactions: { approvalPromptsUnavailable: true },
            }),
          );
          const run = yield* sdk.start({
            agent: {
              name: 'overflowing',
              description: 'Sends a request the provider refuses.',
              prompt: 'GOLDEN-OVERFLOW: answer.',
            },
            instruction: 'Answer.',
            model: 'openai/gpt-5.6-sol',
          });

          const end = yield* run.result;
          expect(end).toMatchObject({
            outcome: 'failed',
            error: { kind: 'context-window' },
          });
          expect(end.error?.message).toContain('exceeds the context window');
          yield* closeTestSession(roots.storage);
        }),
    );
  },
);
