/**
 * A message's admission to a run, over a real session: its log, its run
 * registry and its inbox, with the store failed where a case needs a write
 * that does not land.
 */
import { layer } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Scheduler } from 'effect';
import { expect } from 'vitest';

import {
  qualifyAggregateId,
  RunIdSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import { Inbox } from '@agent/followUp/Inbox';
import type { FollowUpReader } from '@agent/followUp/FollowUpReader';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog } from '@shared/session/runHistory';
import { startedRun } from '@test/support/scriptedRunLayers';
import { holdTestRun } from '@test/support/sessionTestUtils';
import {
  persistentTestSession,
  sessionStoreFaults,
} from '@test/support/storeFaults';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

/** The text of every `followup.queued` row the run holds, in commit order. */
const queuedTexts = (session: Context.Context<SessionServices>, runId: RunId) =>
  Effect.gen(function* () {
    const log = Context.get(session, SessionLog);
    yield* log.settled;
    const rows = yield* log.history(
      qualifyAggregateId('run', runId),
      undefined,
      ['followup.queued'],
    );
    return rows.flatMap((row) =>
      row.type === 'followup.queued' ? [row.content.text] : [],
    );
  });

/** What `input` takes now without blocking (nothing is consumed). */
const taken = (input: FollowUpReader) =>
  Effect.gen(function* () {
    const batch = (yield* input.hasPending('idle'))
      ? yield* input.next('idle')
      : null;
    return batch?.kind !== 'followUps'
      ? []
      : batch.followUps.map((followUp) => followUp.content.text);
  });

const user = (text: string) => ({ text, from: { kind: 'user' as const } });

const childResult = (deliveryId: string) => ({
  text: 'child result',
  from: { kind: 'run' as const, runId: RunIdSchema.make('c41dc41dc41d') },
  deliveryId,
});

layer(SessionGraph.hosted, { excludeTestServices: true })('run input', (it) => {
  it.layer(FakeHost.layer({}), { buildPerTest: true })((it) => {
    it.effect(
      'orders concurrent submissions to an idle run, their fibers yielding every few steps',
      () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const runId = yield* startedRun(session);

          const fibers = [];
          for (const text of ['one', 'two', 'three']) {
            fibers.push(
              yield* Effect.forkChild(
                submitFollowUp(runId, user(text), {}).pipe(
                  Effect.provide(session),
                  Effect.provideService(Scheduler.MaxOpsBeforeYield, 3),
                ),
              ),
            );
          }
          // Each send commits in call order, whatever the interleaving: the
          // run's send lane holds a later send until the earlier one's row.
          // The first send wakes the idle run; a later one may find it live.
          const statuses = [];
          for (const fiber of fibers)
            statuses.push((yield* Fiber.join(fiber)).status);
          expect(statuses[0]).toBe('queued');
          expect(statuses.every((status) => status !== 'failed')).toBe(true);
          expect(yield* queuedTexts(session, runId)).toEqual([
            'one',
            'two',
            'three',
          ]);
        }),
    );

    it.effect('admits a replayed child delivery at most once', () =>
      Effect.gen(function* () {
        const session = yield* isolatedTestSession();
        const runId = yield* startedRun(session);
        yield* holdTestRun(session, runId);
        const delivery = childResult('exec-1:turn:1:delivery');

        // A producer repeating the same logical result must not append
        // another parent message; the live generation reads the one row.
        for (let replay = 0; replay <= 100; replay++) {
          expect(
            yield* submitFollowUp(runId, delivery, {}).pipe(
              Effect.provide(session),
            ),
          ).toEqual({ status: 'sent' });
        }
        expect(yield* queuedTexts(session, runId)).toEqual(['child result']);
      }),
    );

    it.effect(
      'delivers a successor reader every row still queued, in commit order',
      () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const inbox = Context.get(session, Inbox);
          const id = yield* startedRun(session);
          yield* Effect.scoped(
            Effect.andThen(
              inbox.open(id),
              inbox.send(id, user('during the first generation')),
            ),
          );
          yield* inbox.send(id, user('between generations'));
          yield* inbox.owesResume(id);

          const input = yield* inbox.open(id);
          expect(yield* taken(input)).toEqual([
            'during the first generation',
            'between generations',
          ]);
        }),
    );

    it.effect(
      'a closed run refuses senders from its rows until a reader opens here',
      () =>
        Effect.gen(function* () {
          // The close is the run's `followup.closed` row, not an in-memory
          // mark: the session reads only the rows.
          const session = yield* isolatedTestSession();
          const inbox = Context.get(session, Inbox);
          const closed = yield* startedRun(session);
          const open = yield* startedRun(session);
          yield* inbox.closeInput(closed);
          yield* Context.get(session, SessionLog).settled;

          expect(yield* inbox.send(closed, user('still closed'))).toEqual({
            kind: 'refused',
            reason: 'notResumable',
          });
          expect(yield* queuedTexts(session, closed)).toEqual([]);
          expect(yield* inbox.send(open, user('never closed'))).toMatchObject({
            kind: 'queued',
          });

          // The generation that reactivates it reads its input again.
          yield* inbox.open(closed);
          expect(yield* inbox.send(closed, user('reopened'))).toMatchObject({
            kind: 'queued',
          });
        }),
    );

    // #9531: the second send of a delivery must not be told `duplicate`
    // for a first write that never landed.
    it.effect(
      'judges a concurrent duplicate against the first write, never before it settles',
      () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          const session = yield* persistentTestSession();
          const faults = yield* sessionStoreFaults(roots.storage);
          const inbox = Context.get(session, Inbox);
          const id = yield* startedRun(session);
          yield* inbox.open(id);
          yield* faults.failNext('appendAll', 'followup.queued');
          const delivery = childResult('exec-2:turn:1:delivery');

          const [first, second] = yield* Effect.all(
            [
              Effect.exit(inbox.send(id, delivery)),
              Effect.exit(inbox.send(id, delivery)),
            ],
            { concurrency: 'unbounded' },
          );

          expect(Exit.isFailure(first)).toBe(true);
          expect(second).toEqual(Exit.succeed({ kind: 'queued' }));
          expect(yield* queuedTexts(session, id)).toEqual(['child result']);
        }),
    );
  });
});
