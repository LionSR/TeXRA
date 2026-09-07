// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import { sweepLeftoverStreams } from '@controllers/session/sweepLeftoverStreams';
import {
  aggregateId,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
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

describe('committed stream removal', () => {
  it.live(
    'detaches a retained child when the session receives a committed parent removal',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const parent = 'removed-parent' as StreamTabId;
          const child = 'retained-child' as StreamTabId;
          const executionId = 'aabb1234' as ExecutionId;
          publishTestRunStart(session, parent);
          publishTestRunStart(session, child, executionId);
          yield* Effect.promise(() => session.settlePublications());
          const handle = testExecutionHandle({
            executionId,
            parentStreamId: parent,
            childStreamId: child,
            agent: 'chat',
          });
          session.executions.track(handle);
          yield* Effect.promise(() => session.settlePublications());
          yield* Effect.promise(async () =>
            runInSession(session, () =>
              GoalStore.start(parent, 'Determine the boundary conditions.'),
            ),
          );
          const question = session.interactions.askUserQuestion({
            requestId: 'question:removed-parent',
            streamId: parent,
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
              type: 'stream.removed',
              aggregateId: aggregateId('stream', parent),
            },
          ]);
          yield* Effect.promise(() => session.settlePublications());
          expect(yield* Effect.promise(() => question)).toEqual({
            action: 'reject',
            cause: 'Stream removed.',
          });
          expect(handle.isOwnedBy(parent)).toBe(false);
          expect(session.hasStream(parent)).toBe(false);
          expect(session.hasStream(child)).toBe(true);
          expect(session.now()).toBe(before + 1);
          expect(
            yield* Effect.sync(() =>
              runInSession(session, () => GoalStore.getForStream(parent)),
            ),
          ).toBeNull();
        }),
      ),
  );

  it.live(
    'holds an execution deletion through interrupted cleanup before admitting a launch',
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
              session.executions.withExecutionStep('aabbccdd', operation),
            );
            yield* Deferred.await(started);
            const interruption = yield* Effect.forkScoped(
              Fiber.interrupt(deletion),
            );
            yield* Deferred.await(cleaning);
            let launched = false;
            const launch = session.executions.launchExecution(
              'aabbccdd',
              async () => {
                launched = true;
              },
            );
            yield* Effect.promise(() =>
              session.executions.launchExecution(
                '11223344',
                async () => undefined,
              ),
            );
            expect(launched).toBe(false);
            yield* Deferred.succeed(releaseCleanup, undefined);
            yield* Fiber.join(interruption);
            yield* Effect.promise(() => launch);
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
          const shell = 'leftover-shell' as StreamTabId;
          const active = 'active-shell' as StreamTabId;
          const unknown = 'bash@unknown' as StreamTabId;
          const agent = 'saved-agent' as StreamTabId;
          session.executions.track(
            testExecutionHandle({
              executionId: 'bb2233',
              parentStreamId: active,
              agent: 'bash',
            }),
          );
          session.publish([
            {
              type: 'run.start',
              aggregateId: aggregateId('stream', shell),
              executionId: 'aa1122',
              identity: { kind: 'process', tool: 'bash' },
              category: 'toolUse',
              isRemote: false,
              userFollowUpSupport: 'unsupported',
            },
            {
              type: 'run.start',
              aggregateId: aggregateId('stream', active),
              executionId: 'bb2233',
              identity: { kind: 'process', tool: 'bash' },
              category: 'toolUse',
              isRemote: false,
              userFollowUpSupport: 'unsupported',
            },
            {
              type: 'run.start',
              aggregateId: aggregateId('stream', unknown),
              executionId: 'cc3344',
              category: 'toolUse',
              isRemote: false,
              userFollowUpSupport: 'unsupported',
            },
          ]);
          publishTestRunStart(session, agent);
          yield* Effect.promise(() => session.settlePublications());
          const rows = yield* Effect.all(
            [shell, active, unknown, agent].map((id) =>
              Stream.runCollect(
                session.events.aggregate(aggregateId('stream', id), 0),
              ),
            ),
          );
          yield* sweepLeftoverStreams(session, rows.flat());
          yield* Stream.runHead(
            session.viewChanges.pipe(
              Stream.filter((view) => !view.streams.has(shell)),
            ),
          );
          expect(session.hasStream(active)).toBe(true);
          expect(session.hasStream(unknown)).toBe(true);
          expect(session.hasStream(agent)).toBe(true);
        }),
      ),
  );
});
