import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Semaphore } from 'effect';
import { afterEach, describe, expect, vi, type Mock } from 'vitest';

import * as resumability from '@agent/storage/resumability';
import { RunInput } from '@agent/followUp/RunInput';
import {
  presentFollowUpResult,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import {
  ToolUseFollowUpQueue,
  type FollowUpConsumerLease,
} from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { ToolUseFollowUpTarget } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentResume,
  AgentResumeFailed,
  type AgentResumePort,
} from '@platform/interfaces';
import { aggregateId, type RunId, type SessionEvent } from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { foldRunRows, type QueuedFollowUp } from '@shared/session/runRows';
import type { Append } from '@shared/session/sessionEvents';
import { createDeferred } from '@test/support/asyncTestUtils';
import { generateRunId } from '@utils/core';

/** Let a forked submission reach its parked resume Promise. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

function mockTryResume(): Mock<
  () => Effect.Effect<boolean, AgentResumeFailed>
> {
  return vi.fn(() => Effect.succeed(true));
}

/** Provide a case's resume port as the `AgentResume` service the wake reads:
 *  production takes the process service; a suite substitutes it. */
const withResumePort =
  (tryResumeRun: AgentResumePort['tryResumeRun']) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, AgentResume>> =>
    Effect.provideService(effect, AgentResume, { tryResumeRun });

/**
 * The admission boundary over a recorded session plane: one serializer (a
 * one-permit semaphore standing in for the publisher), the rows it appended,
 * and the runs it claimed. `queued(runId)` is the text of every
 * `followup.queued` row written for the run, in order; what a consumer
 * takes is what the rows still queue, as the publisher's pending set holds
 * it. `claimRefused` answers each claim the way
 * a live foreign owner does; `failWrites` refuses that many appends.
 */
function recordedFollowUps(
  options: {
    claimRefused?: boolean;
    failWrites?: number;
    /** Refuse any transaction carrying a follow-up with this text. */
    failText?: string;
  } = {},
) {
  const rows: SessionEvent[] = [];
  const claims: RunId[] = [];
  let failWrites = options.failWrites ?? 0;
  const publisher = Semaphore.makeUnsafe(1);
  const append: Append = (events) =>
    Effect.suspend(() => {
      const refusedText = events.some(
        (event) =>
          event.type === 'followup.queued' &&
          event.content.text === options.failText,
      );
      if (failWrites > 0 || refusedText) {
        if (!refusedText) failWrites -= 1;
        return Effect.fail(
          new DatabaseWriteFailed({
            path: ':memory:',
            cause: new Error('disk full'),
          }),
        );
      }
      const committed = events.map(
        (event) =>
          ({
            ...event,
            seq: rows.length + 1,
            commit: rows.length + 1,
            ownerId: null,
            at: 0,
          }) as SessionEvent,
      );
      rows.push(...committed);
      return Effect.succeed(committed);
    });
  const runRows = (runId: RunId) =>
    rows.filter((row) => row.aggregateId === aggregateId('run', runId));
  const followUps = new ToolUseFollowUpQueue({
    exclusive: (job) => publisher.withPermits(1)(job(append)),
    detach: (job) => {
      Effect.runFork(publisher.withPermits(1)(job));
    },
    pending: (runId) => foldRunRows(runRows(runId)).followUps,
    rows: (runId) => Effect.sync(() => runRows(runId)),
    acquireClaim: (runId) =>
      Effect.suspend(() => {
        claims.push(runId);
        return options.claimRefused
          ? Effect.fail(
              new DatabaseWriteFailed({
                path: ':memory:',
                cause: new DatabaseClaimRefused({
                  ownerId: JSON.stringify(['other-host', 4321, null]),
                  verdict: 'alive',
                }),
              }),
            )
          : Effect.succeed(Effect.void);
      }),
  });
  const queuedRows = (runId: RunId) =>
    rows.flatMap((row) =>
      row.type === 'followup.queued' &&
      row.aggregateId === aggregateId('run', runId)
        ? [row]
        : [],
    );
  return {
    followUps,
    claims,
    queuedRows,
    queued: (runId: RunId) => queuedRows(runId).map((row) => row.content.text),
  };
}

/** What a consumer attaching its input to `lease` takes without blocking. */
const taken = (followUps: ToolUseFollowUpQueue, lease: FollowUpConsumerLease) =>
  Effect.gen(function* () {
    const input = followUps.attachInput(lease.runId, lease)!;
    const batch = input.hasQueued() ? yield* input.take : null;
    return batch === null || batch.synthetic
      ? []
      : batch.followUps.map((followUp) => followUp.content.text);
  });

let recorded = recordedFollowUps();

function fakeSession(target: ToolUseFollowUpTarget): SessionHandle {
  recorded = recordedFollowUps();
  return {
    runs: { getToolUseFollowUpTarget: () => target },
    readRunRecords: () => Effect.succeed([]),
    // No database behind this fixture, so the claim read fails and the
    // refusal is the unclassified one, as it was when the ownership fact
    // lived on disk.
    claimOwner: () => Effect.fail(new Error('claim store unavailable')),
    status: { clearHold: () => {}, markUnavailable: () => {} },
    followUps: recorded.followUps,
  } as unknown as SessionHandle;
}

function activeTarget(): ToolUseFollowUpTarget {
  return {
    kind: 'active',
    context: {
      ownerSession: {} as SessionHandle,
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => Effect.succeed(undefined),
      switchModel: () => Effect.void,
      interrupt: () => {},
    },
  };
}

describe('submitFollowUp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect(
    'uses the live child owner while waiting, between turns, and during a turn',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const child = session.followUps.claimLive(runId, 'child')!;
        const tryResumeRun = mockTryResume();

        for (const text of ['while waiting', 'between turns', 'during turn']) {
          expect(
            yield* submitFollowUp(runId, text, { session }).pipe(
              withResumePort(tryResumeRun),
            ),
          ).toMatchObject({ status: 'queued' });
        }

        expect(tryResumeRun).not.toHaveBeenCalled();
        expect(yield* taken(session.followUps, child)).toEqual([
          'while waiting',
          'between turns',
          'during turn',
        ]);
      }),
  );

  it.effect('reports input admitted by a live flow as sent', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession(activeTarget());
      const sent: RunId[] = [];
      session.followUps.onSent((sentRunId) => sent.push(sentRunId));
      const flow = session.followUps.claimLive(runId, 'flow')!;
      const tryResumeRun = mockTryResume();

      expect(
        yield* submitFollowUp(runId, 'during active turn', { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      ).toEqual({ status: 'sent' });

      expect(tryResumeRun).not.toHaveBeenCalled();
      expect(yield* taken(session.followUps, flow)).toEqual([
        'during active turn',
      ]);
      expect(sent).toEqual([runId]);
    }),
  );

  it.effect(
    'does not report an automatic live-flow notification as user input',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession(activeTarget());
        const sent: RunId[] = [];
        session.followUps.onSent((sentRunId) => sent.push(sentRunId));
        const flow = session.followUps.claimLive(runId, 'flow')!;

        expect(
          yield* submitFollowUp(runId, 'child progress', {
            session,
            mode: 'live_notification',
          }).pipe(withResumePort(mockTryResume())),
        ).toEqual({ status: 'queued' });

        expect(yield* taken(session.followUps, flow)).toEqual([
          'child progress',
        ]);
        expect(sent).toEqual([]);
      }),
  );

  it.effect(
    'enqueues live notifications for a waiting parent without child owner',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const tryResumeRun = mockTryResume();

        // Create a child-owned entry (simulates a running child loop), then
        // release the lease so the entry exists but has no owner — the exact
        // state of a WAITING parent queue after a child finishes its turn and
        // a live_notification (progress update, run event) arrives.
        const child = session.followUps.claimLive(runId, 'child')!;
        session.followUps.release(child, 'recoverable');

        // live_notification on a WAITING queue without child owner should enqueue
        // without claiming recovery or triggering a stream resume.
        const result = yield* submitFollowUp(runId, 'child progress', {
          session,
          mode: 'live_notification',
        }).pipe(withResumePort(tryResumeRun));

        expect(result).toMatchObject({ status: 'queued' });
        expect(tryResumeRun).not.toHaveBeenCalled();
        expect(recorded.queued(runId)).toEqual(['child progress']);
      }),
  );

  it.effect('claims one recovery and orders repeated submissions once', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({ kind: 'queue' });
      const barrier = createDeferred<boolean>();
      const claimed: unknown[] = [];
      const tryResumeRun = vi.fn((_: RunId, recovery: unknown) => {
        claimed.push(recovery);
        return Effect.promise(() => barrier.promise);
      });

      const first = yield* Effect.forkChild(
        submitFollowUp(runId, 'one', { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      );
      const second = yield* Effect.forkChild(
        submitFollowUp(runId, 'two', { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      );
      const third = yield* Effect.forkChild(
        submitFollowUp(runId, 'three', { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      );

      yield* settle;
      expect(tryResumeRun).toHaveBeenCalledTimes(1);
      expect(claimed).toHaveLength(1);
      expect(yield* Fiber.join(second)).toEqual({ status: 'queued' });
      expect(yield* Fiber.join(third)).toEqual({ status: 'queued' });
      expect(recorded.queued(runId)).toEqual(['one', 'two', 'three']);

      barrier.resolve(true);
      expect(yield* Fiber.join(first)).toEqual({ status: 'queued' });
    }),
  );

  it.effect(
    'releases declined recovery after the submitting fiber is interrupted',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const resumed = createDeferred<boolean>();
        const started = yield* Deferred.make<void>();
        const admitted = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          submitFollowUp(runId, 'keep this input', {
            session,
            onAdmitted: () => {
              Deferred.doneUnsafe(admitted, Effect.void);
            },
          }).pipe(
            withResumePort(() => {
              Deferred.doneUnsafe(started, Effect.void);
              return Effect.promise(() => resumed.promise);
            }),
          ),
        );
        // The host is asked before the submitter is told it was admitted, so
        // the interrupt below lands on a wake already in flight.
        yield* Deferred.await(started);
        yield* Deferred.await(admitted);
        yield* Fiber.interrupt(fiber);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        resumed.resolve(false);
        // The wake is detached: it answers the decline and settles the lease
        // even though the fiber that dispatched it is gone.
        yield* settle;

        const successor = session.followUps.claimLive(runId, 'child');
        expect(successor).toBeDefined();
        // The input is the run's row, whichever consumer takes it next.
        expect(recorded.queued(runId)).toEqual(['keep this input']);
      }),
  );

  it.effect('releases recovery when tryResumeRun fails', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({ kind: 'queue' });
      expect(
        yield* submitFollowUp(runId, 'keep this input', { session }).pipe(
          withResumePort(() =>
            Effect.fail(
              new AgentResumeFailed({
                runId,
                message: 'resume prep failed',
                cause: new Error('resume prep failed'),
              }),
            ),
          ),
        ),
      ).toEqual({ status: 'queued', wake: 'failed' });
      expect(session.followUps.claimLive(runId, 'child')).toBeDefined();
      expect(recorded.queued(runId)).toEqual(['keep this input']);
    }),
  );

  it.effect('starts recovery after the child generation releases', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({ kind: 'queue' });
      const child = session.followUps.claimLive(runId, 'child')!;
      session.followUps.release(child, 'recoverable');
      const tryResumeRun = mockTryResume();

      expect(
        yield* submitFollowUp(runId, 'continue', { session }).pipe(
          withResumePort(tryResumeRun),
        ),
      ).toEqual({ status: 'queued' });
      expect(tryResumeRun).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    'admits a child delivery to the retained queue after the parent completes',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const parent = session.followUps.claimLive(runId, 'flow')!;
        session.followUps.release(parent, 'recoverable');
        const deriveSpy = vi.spyOn(resumability, 'deriveResumability');
        const tryResumeRun = mockTryResume();

        expect(
          yield* submitFollowUp(
            runId,
            { text: 'retained child result', origin: 'subagent_result' },
            { session },
          ).pipe(withResumePort(tryResumeRun)),
        ).toEqual({ status: 'queued' });

        expect(deriveSpy).not.toHaveBeenCalled();
        expect(recorded.queued(runId)).toEqual(['retained child result']);
      }),
  );

  it.effect('refuses child delivery to a parent with no session', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const session = fakeSession({
        kind: 'no_session',
        runStatus: 'completed',
      });
      const tryResumeRun = mockTryResume();

      expect(
        yield* submitFollowUp(
          runId,
          { text: 'late child result', origin: 'subagent_result' },
          { session },
        ).pipe(withResumePort(tryResumeRun)),
      ).toEqual({ status: 'failed', reason: 'not_resumable' });
      expect(tryResumeRun).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'admits a replayed child delivery at most once and wakes at most once',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const session = fakeSession({ kind: 'queue' });
        const tryResumeRun = mockTryResume();
        const delivery = {
          text: 'child result',
          origin: 'subagent_result' as const,
          deliveryId: 'exec-1:turn:1:delivery',
        };

        expect(
          yield* submitFollowUp(runId, delivery, { session }).pipe(
            withResumePort(tryResumeRun),
          ),
        ).toEqual({ status: 'queued' });
        expect(tryResumeRun).toHaveBeenCalledTimes(1);

        // A producer repeating the same logical result callback must not append
        // another parent message nor trigger another parent wake.
        for (let replay = 0; replay < 100; replay++) {
          expect(
            yield* submitFollowUp(runId, delivery, { session }).pipe(
              withResumePort(tryResumeRun),
            ),
          ).toEqual({ status: 'sent' });
        }
        expect(tryResumeRun).toHaveBeenCalledTimes(1);
        expect(recorded.queuedRows(runId)).toMatchObject([
          {
            followUpId: delivery.deliveryId,
            content: { text: 'child result' },
          },
        ]);
      }),
  );
});

describe('ToolUseFollowUpQueue claim exclusivity', () => {
  it.effect('makes recovery-vs-child claims exclusive in either order', () =>
    Effect.gen(function* () {
      const runId = generateRunId();
      const recoveryFirst = recordedFollowUps().followUps;
      const submission = yield* recoveryFirst.submit(
        runId,
        { text: 'recover' },
        'recoverable',
      );
      expect(submission).toMatchObject({ kind: 'queued' });
      expect(submission.kind === 'queued' && submission.lease).toBeTruthy();
      expect(recoveryFirst.claimLive(runId, 'child')).toBeUndefined();

      const childFirst = recordedFollowUps().followUps;
      expect(childFirst.claimLive(runId, 'child')).toBeDefined();
      expect(childFirst.claimRecovery(runId)).toBeUndefined();
    }),
  );
});

describe('ToolUseFollowUpQueue ownership', () => {
  it('allows exactly one live or recovery owner', () => {
    const { followUps } = recordedFollowUps();
    const id = generateRunId();
    const child = followUps.claimLive(id, 'child');
    expect(child).toBeDefined();
    expect(followUps.claimLive(id, 'flow')).toBeUndefined();
    expect(followUps.claimRecovery(id)).toBeUndefined();

    expect(followUps.release(child!, 'recoverable')).toBe(true);
    const recovery = followUps.claimRecovery(id);
    expect(recovery).toBeDefined();
    expect(followUps.claimLive(id, 'child')).toBeUndefined();
  });

  it.effect(
    'delivers a successor generation every row still queued, in commit order, and ignores a stale release',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        const child = followUps.claimLive(id, 'child')!;
        yield* followUps.submit(id, { text: 'before handoff' }, 'live_owner');
        followUps.release(child, 'recoverable');
        const recovery = followUps.claimRecovery(id)!;
        expect(
          yield* followUps.submit(
            id,
            { text: 'during recovery' },
            'recoverable',
          ),
        ).toEqual({ kind: 'queued' });

        expect(followUps.release(child, 'terminal')).toBe(false);
        expect(queued(id)).toEqual(['before handoff', 'during recovery']);
        // The row the earlier generation never took and the one admitted
        // under recovery arrive the same way, in commit order.
        expect(yield* taken(followUps, recovery)).toEqual([
          'before handoff',
          'during recovery',
        ]);
      }),
  );

  it.effect(
    'queues live_owner notifications on a recoverable entry without claiming',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        const child = followUps.claimLive(id, 'child')!;
        followUps.release(child, 'recoverable');

        expect(
          yield* followUps.submit(id, { text: 'progress' }, 'live_owner'),
        ).toEqual({ kind: 'queued' });
        expect(queued(id)).toEqual(['progress']);
        // The entry stays recoverable: a later recovery claim acquires it.
        expect(followUps.claimRecovery(id)).toBeDefined();
      }),
  );

  it.effect(
    'refuses a run another process holds, writing nothing and keeping the input offerable',
    () =>
      Effect.gen(function* () {
        // A cold run (no consumer here) is claimed before its row is written,
        // as a resume claims it; a live foreign owner refuses that claim.
        const { followUps, queued, claims } = recordedFollowUps({
          claimRefused: true,
        });
        const id = generateRunId();
        const delivery = {
          text: 'child result',
          origin: 'subagent_result' as const,
          deliveryId: 'd-held',
        };

        expect(yield* followUps.submit(id, delivery, 'recoverable')).toEqual({
          kind: 'refused',
          reason: 'owned_elsewhere',
        });
        expect(claims).toEqual([id]);
        expect(queued(id)).toEqual([]);
        // The admission rolled back: the delivery id is not remembered as
        // admitted (a retry is tried again, not reported as a duplicate), and
        // no recovery lease is stranded.
        expect(yield* followUps.submit(id, delivery, 'recoverable')).toEqual({
          kind: 'refused',
          reason: 'owned_elsewhere',
        });
        expect(followUps.claimRecovery(id)).toBeDefined();
      }),
  );

  it.effect(
    'forgets a terminal run so a late live-owner submission is refused',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        const lease = followUps.claimLive(id, 'flow')!;
        followUps.release(lease, 'terminal');

        expect(followUps.hasLiveOwner(id)).toBe(false);
        expect(
          yield* followUps.submit(id, { text: 'late' }, 'live_owner'),
        ).toEqual({ kind: 'refused' });
        expect(queued(id)).toEqual([]);
      }),
  );

  it.effect('starts a new child generation for an authorized retry', () =>
    Effect.gen(function* () {
      const { followUps } = recordedFollowUps();
      const id = generateRunId();
      const first = followUps.claimChildRun(id)!;
      followUps.release(first, 'terminal');

      expect(
        yield* followUps.submit(id, { text: 'late' }, 'live_owner'),
      ).toEqual({ kind: 'refused' });

      const retry = followUps.claimChildRun(id);
      expect(retry?.kind).toBe('child');
      expect(
        yield* followUps.submit(
          id,
          { text: 'current generation' },
          'live_owner',
        ),
      ).toEqual({ kind: 'queued' });
      expect(followUps.hasLiveOwner(id)).toBe(true);
    }),
  );

  it.effect('deletion invalidates a live generation', () =>
    Effect.gen(function* () {
      const { followUps } = recordedFollowUps();
      const id = generateRunId();
      const lease = followUps.claimLive(id, 'child')!;

      expect(followUps.terminalize(id)).toBe(true);
      expect(followUps.release(lease, 'recoverable')).toBe(false);
      expect(
        yield* followUps.submit(id, { text: 'late' }, 'live_owner'),
      ).toEqual({ kind: 'refused' });
    }),
  );

  it.effect('refuses to rebuild entries after dispose', () =>
    Effect.gen(function* () {
      const { followUps } = recordedFollowUps();
      const liveId = generateRunId();
      followUps.claimLive(liveId, 'flow');
      followUps.dispose();

      expect(followUps.claimLive(liveId, 'flow')).toBeUndefined();
      expect(followUps.claimChildRun(generateRunId())).toBeUndefined();
      expect(followUps.claimRecovery(liveId, true)).toBeUndefined();
      expect(
        yield* followUps.submit(liveId, { text: 'late' }, 'recoverable'),
      ).toEqual({ kind: 'refused' });
      expect(followUps.terminalize(liveId)).toBe(false);
    }),
  );

  it.effect('never lets a maintenance wake share a batch with follow-ups', () =>
    Effect.gen(function* () {
      const pending: QueuedFollowUp[] = [];
      const input = new RunInput(() => pending);
      input.wake('compact');
      const followUp = (text: string) => ({
        followUpId: text,
        content: { text, origin: 'user' as const },
      });
      pending.push(followUp('first'), followUp('second'));
      input.notify();

      expect(yield* input.take).toEqual({ synthetic: true, text: 'compact' });
      expect(yield* input.take).toEqual({
        synthetic: false,
        followUps: [followUp('first'), followUp('second')],
      });
      input.end();
      expect(yield* input.take).toBeNull();
    }),
  );
});

describe('ToolUseFollowUpQueue delivery identity (#9531)', () => {
  const childResult = (deliveryId: string) => ({
    text: 'child result',
    origin: 'subagent_result' as const,
    deliveryId,
  });

  it.effect(
    'suppresses a replayed delivery id instead of queueing it again',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        followUps.claimLive(id, 'flow');
        const delivery = childResult('exec-1:turn:1:delivery');

        expect(yield* followUps.submit(id, delivery, 'live_owner')).toEqual({
          kind: 'delivered_live',
        });
        for (let replay = 0; replay < 100; replay++) {
          expect(yield* followUps.submit(id, delivery, 'live_owner')).toEqual({
            kind: 'duplicate',
          });
        }
        expect(queued(id)).toEqual(['child result']);
      }),
  );

  it.effect(
    'judges a concurrent duplicate against the first write, never before it settles',
    () =>
      Effect.gen(function* () {
        // The first write fails: the second submission of the same delivery
        // must not have been told `duplicate` for a row that never landed.
        const { followUps, queued } = recordedFollowUps({ failWrites: 1 });
        const id = generateRunId();
        followUps.claimLive(id, 'flow');
        const delivery = childResult('exec-2:turn:1:delivery');

        const [first, second] = yield* Effect.all(
          [
            Effect.exit(followUps.submit(id, delivery, 'live_owner')),
            Effect.exit(followUps.submit(id, delivery, 'live_owner')),
          ],
          { concurrency: 'unbounded' },
        );

        expect(Exit.isFailure(first)).toBe(true);
        expect(second).toEqual(Exit.succeed({ kind: 'delivered_live' }));
        expect(queued(id)).toEqual(['child result']);
      }),
  );

  it.effect(
    'keeps distinct delivery ids distinct even with identical text',
    () =>
      Effect.gen(function* () {
        const { followUps, queuedRows } = recordedFollowUps();
        const id = generateRunId();
        followUps.claimLive(id, 'flow');

        for (const deliveryId of ['d1', 'd2']) {
          expect(
            yield* followUps.submit(
              id,
              { text: 'same text', origin: 'subagent_result', deliveryId },
              'live_owner',
            ),
          ).toEqual({ kind: 'delivered_live' });
        }
        expect(queuedRows(id).map((row) => row.followUpId)).toEqual([
          'd1',
          'd2',
        ]);
      }),
  );

  it.effect('queues a batch as one transaction: whole, or not at all', () =>
    Effect.gen(function* () {
      const { followUps, queued } = recordedFollowUps({
        failText: 'second',
      });
      const id = generateRunId();
      followUps.claimLive(id, 'child');

      const failed = yield* Effect.exit(
        followUps.submitBatch(
          id,
          [{ text: 'first' }, { text: 'second' }],
          'live_owner',
        ),
      );
      // The second row's refusal takes the first with it: a caller that
      // restores the batch offers nothing that already committed.
      expect(Exit.isFailure(failed)).toBe(true);
      expect(queued(id)).toEqual([]);

      expect(
        yield* followUps.submitBatch(
          id,
          [{ text: 'first' }, { text: 'third' }],
          'live_owner',
        ),
      ).toEqual({ kind: 'queued' });
      expect(queued(id)).toEqual(['first', 'third']);
    }),
  );

  it.effect(
    'finds a replayed id still queued across a recoverable release, writing nothing',
    () =>
      Effect.gen(function* () {
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        const child = followUps.claimLive(id, 'child')!;
        const delivery = childResult('d1');
        yield* followUps.submit(id, delivery, 'live_owner');
        followUps.release(child, 'recoverable');

        // Still queued on the rows: the run is woken for it, and no second
        // row is written.
        expect(
          yield* followUps.submit(id, delivery, 'recoverable'),
        ).toMatchObject({ kind: 'queued', lease: { kind: 'recovery' } });
        expect(queued(id)).toEqual(['child result']);
      }),
  );

  it.effect('never suppresses input that carries no delivery id', () =>
    Effect.gen(function* () {
      const { followUps, queuedRows } = recordedFollowUps();
      const id = generateRunId();
      followUps.claimLive(id, 'flow');

      yield* followUps.submit(id, { text: 'repeat me' }, 'live_owner');
      yield* followUps.submit(id, { text: 'repeat me' }, 'live_owner');

      const rows = queuedRows(id);
      expect(rows.map((row) => row.content.text)).toEqual([
        'repeat me',
        'repeat me',
      ]);
      expect(rows[0]!.followUpId).not.toBe(rows[1]!.followUpId);
    }),
  );

  it.effect.each(['flow', 'recovered-child', 'recovered-root'] as const)(
    'a deferred admission waits for resubmission before offering to %s',
    (consumer) =>
      Effect.gen(function* () {
        // #8093: a child whose own finalize must land first admits its result
        // deferred; the row is durable but the parent's live input is not
        // woken. The post-finalize resubmit of the same delivery id is a
        // replay against the committed row, and THAT offer is what reaches
        // the consumer.
        const { followUps, queued } = recordedFollowUps();
        const id = generateRunId();
        const recovery =
          consumer === 'flow' ? undefined : followUps.claimRecovery(id, true);
        let lease = recovery ?? followUps.claimLive(id, 'flow')!;
        if (consumer === 'recovered-child') {
          lease = followUps.claimChildRun(id, recovery!)!;
          expect(followUps.useRecovery(recovery!)).toBeUndefined();
          expect(followUps.release(recovery!, 'recoverable')).toBe(false);
        }
        if (consumer !== 'recovered-root')
          expect(followUps.hasLiveOwner(id)).toBe(true);
        const input = followUps.attachInput(id, lease)!;
        const delivery = childResult('d1');

        expect(
          yield* followUps.submit(id, delivery, 'recoverable', {
            liveOffer: 'deferred',
          }),
        ).toEqual({ kind: 'queued' });
        expect(queued(id)).toEqual(['child result']);
        expect(input.hasQueued()).toBe(false);
        // A wake for another reason does not carry the deferred row with it:
        // the parent must not take the result before the child's run.end.
        yield* followUps.submit(id, { text: 'user input' }, 'recoverable');
        expect(yield* taken(followUps, lease)).toEqual(['user input']);

        expect(yield* followUps.submit(id, delivery, 'recoverable')).toEqual({
          kind: 'duplicate',
        });
        expect(queued(id)).toEqual(['child result', 'user input']);
        // Nothing consumed the first batch here, so the take after the
        // resubmit reads both rows, in commit order.
        expect(yield* taken(followUps, lease)).toEqual([
          'child result',
          'user input',
        ]);
      }),
  );
});

describe('ToolUseFollowUpQueue terminal tombstones', () => {
  it.effect('evicts the oldest tombstone at the historical cap', () =>
    Effect.gen(function* () {
      const { followUps } = recordedFollowUps();
      const runIds = Array.from(
        { length: ToolUseFollowUpQueue.TERMINALIZED_CAP + 1 },
        () => generateRunId(),
      );
      for (const runId of runIds) followUps.terminalize(runId);

      expect(
        yield* followUps.submit(
          runIds[0]!,
          { text: 'after eviction' },
          'recoverable',
        ),
      ).toMatchObject({ kind: 'queued' });
      expect(
        yield* followUps.submit(
          runIds[1]!,
          { text: 'still terminalized' },
          'recoverable',
        ),
      ).toEqual({ kind: 'refused' });
    }),
  );
});

describe('presentFollowUpResult', () => {
  it('words only refusals, with a failed wake as information', () => {
    expect(presentFollowUpResult({ status: 'sent' })).toEqual({
      severity: 'none',
    });
    expect(presentFollowUpResult({ status: 'queued' })).toEqual({
      severity: 'none',
    });
    expect(
      presentFollowUpResult({ status: 'queued', wake: 'failed' }),
    ).toMatchObject({ severity: 'info' });
    expect(
      presentFollowUpResult({ status: 'failed', reason: 'owned_elsewhere' }),
    ).toMatchObject({
      severity: 'warning',
      message: expect.stringContaining('another TeXRA window'),
    });
  });
});
