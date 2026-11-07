// Third-party imports
import { it } from '@effect/vitest';
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { describe, expect } from 'vitest';

// Local imports - package API under test
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { SessionRequests } from '@agent/runtime/requests';
import { Runs } from '@agent/runtime/runRegistry';
import {
  emptySessionView,
  type SessionView as RuntimeSessionView,
} from '@shared/session/sessionView';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { runView } from '../../src/effect/runHandle';
import type { TranscriptSubscription } from '@texra-ai/harness/transcript';

/** A session view run entry as the package's fold keys it. */
interface FakeRunView {
  readonly id: string;
  readonly ancestors: readonly { readonly id: string }[];
  readonly childIds: readonly string[];
  readonly outcome: 'completed' | null;
}
type FakeSessionView = Omit<RuntimeSessionView, 'runs'> & {
  readonly runs: Map<string, FakeRunView>;
};

const RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('ae0001');

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
        outcome: null,
      }),
    })).pipe(Effect.as(0));
  }
}

/** The package's handle on `fake`'s run, from the activation its opening
 *  commits, as `session.start` gives it. */
const startedRun = (fake: FakeSession) =>
  Effect.map(fake.open(), (activation) =>
    runView(contextOf(fake), RUN_ID, activation),
  );

/** `fake` as the session's owners a run's view reads. */
const contextOf = (fake: FakeSession) =>
  // cast: the fake carries only what a run's view reads of each owner.
  Context.make(SessionLog, fake.log as never).pipe(
    // cast: the fake view serves only the ref, changes and inputs a run reads.
    Context.add(SessionViewAccess, fake.view as never),
    // cast: the fake registry serves only the `get` a run's view reads.
    Context.add(Runs, fake.runs as never),
    // cast: the fake answers only the `request` a run's view sends.
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
});
