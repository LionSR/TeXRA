// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Option, Stream } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import { sweepLeftoverRuns } from '@controllers/session/sweepLeftoverRuns';
import { aggregateId, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { GoalStore } from '@tools/goal';

// One restore after each test covers every vi.spyOn in this file.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Own an isolated session for the complete Effect and its finalizers. */
function withSession<A, E, R>(
  fn: (session: SessionHandle) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(createTestSession),
    fn,
    (session) => Effect.sync(() => session.dispose()),
  );
}

describe('committed run removal', () => {
  it.live(
    'detaches a retained child when the session receives a committed parent removal',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const parent = 'aa0001' as RunId;
          const child = 'bb0002' as RunId;
          publishTestRunStart(session, parent);
          publishTestRunStart(session, child, { parent });
          yield* Effect.promise(() => session.settlePublications());
          const handle = testRunHandle({
            runId: child,
            parent,
            agent: 'chat',
          });
          session.runs.track(handle);
          yield* Effect.promise(() => session.settlePublications());
          yield* Effect.promise(async () =>
            runInSession(session, () =>
              GoalStore.start(parent, 'Determine the boundary conditions.'),
            ),
          );
          const question = session.interactions.askUserQuestion({
            requestId: 'question:removed-parent',
            runId: parent,
            questions: [
              {
                question: 'Which normalization should be used?',
                options: [{ label: 'Unit volume' }, { label: 'Unit mass' }],
              },
            ],
            allowBypass: false,
          });
          yield* Effect.promise(() => session.settlePublications());
          const before = session.now();
          session.publish([
            {
              type: 'run.removed',
              aggregateId: aggregateId('run', parent),
            },
          ]);
          yield* Effect.promise(() => session.settlePublications());
          expect(yield* Effect.promise(() => question)).toEqual({
            action: 'reject',
            cause: 'Stream removed.',
          });
          expect(handle.isOwnedBy(parent)).toBe(false);
          expect(session.now()).toBe(before + 1);
          expect(
            yield* Effect.sync(() =>
              runInSession(session, () => GoalStore.getForRun(parent)),
            ),
          ).toBeNull();
        }),
      ),
  );

  it.live(
    'holds a run deletion through interrupted cleanup before admitting a launch',
    () =>
      withSession((session) =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const cleaning = yield* Deferred.make<void>();
            const releaseCleanup = yield* Deferred.make<void>();
            const operation = Effect.acquireUseRelease(
              Effect.void,
              () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                ),
              () =>
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCleanup)),
                ),
            );
            const deletion = yield* Effect.forkScoped(
              session.runs.withInactiveRunStep('aabbccdd' as RunId, operation),
            );
            yield* Deferred.await(started);
            const interruption = yield* Effect.forkScoped(
              Fiber.interrupt(deletion),
            );
            yield* Deferred.await(cleaning);
            let launched = false;
            const launch = yield* Effect.forkScoped(
              session.runs.launchRun(
                'aabbccdd' as RunId,
                Effect.sync(() => {
                  launched = true;
                }),
              ),
              { startImmediately: true },
            );
            yield* session.runs.launchRun('11223344' as RunId, Effect.void);
            expect(launched).toBe(false);
            yield* Deferred.succeed(releaseCleanup, undefined);
            yield* Fiber.join(interruption);
            yield* Fiber.join(launch);
            expect(launched).toBe(true);
          }),
        ),
      ),
  );
});

describe('indexed background-shell cleanup', () => {
  it.live(
    'removes only declared background shells that are not running locally',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const shell = 'cc0001' as RunId;
          const active = 'cc0002' as RunId;
          // Not a background shell: the sweep only removes `process` runs.
          const notAShell = 'cc0003' as RunId;
          const agent = 'cc0004' as RunId;
          session.runs.track(
            testRunHandle({
              runId: active,
              agent: 'bash',
            }),
          );
          session.publish([
            {
              type: 'run.start',
              aggregateId: aggregateId('run', shell),
              identity: { kind: 'process', tool: 'bash' },
              category: 'toolUse',
              isRemote: false,
              userFollowUpSupport: 'unsupported',
              parent: null,
            },
            {
              type: 'run.start',
              aggregateId: aggregateId('run', active),
              identity: { kind: 'process', tool: 'bash' },
              category: 'toolUse',
              isRemote: false,
              userFollowUpSupport: 'unsupported',
              parent: null,
            },
            {
              type: 'run.start',
              aggregateId: aggregateId('run', notAShell),
              identity: { kind: 'agent', agent: 'assistant' },
              category: 'toolUse',
              isRemote: false,
              userFollowUpSupport: 'unsupported',
              parent: null,
            },
          ]);
          publishTestRunStart(session, agent);
          yield* Effect.promise(() => session.settlePublications());
          const rows = yield* Effect.all(
            [shell, active, notAShell, agent].map((id) =>
              Stream.runCollect(
                session.events.aggregate(aggregateId('run', id), 0),
              ),
            ),
          );
          yield* sweepLeftoverRuns(session, rows.flat());
          const swept = yield* Stream.runHead(
            session.viewChanges.pipe(
              Stream.filter((view) => !view.runs.has(shell)),
            ),
          );
          const runs = Option.getOrThrow(swept).runs;
          expect([...runs.keys()].toSorted()).toEqual(
            [active, notAShell, agent].toSorted(),
          );
        }),
      ),
  );
});
