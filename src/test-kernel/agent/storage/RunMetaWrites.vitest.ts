import { it } from '@effect/vitest';
import { Effect, Context } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import { qualifyAggregateId, type RunId } from '@texra-ai/harness/schemas';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Inbox } from '@agent/followUp/ToolUseFollowUp';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
let session: Context.Context<SessionServices>;
const id = 'bbb001' as RunId;
beforeEach(async () => {
  session = await Effect.runPromise(createTestSession());
  publishTestRunStart(session, id);
  await Effect.runPromise(Context.get(session, SessionLog).settled);
});

describe('run metadata updates', () => {
  it.effect(
    'preserves description and outcome when independent facts overlap',
    () =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            Context.get(session, SessionLog).transact([
              {
                type: 'run.description',
                by: 'model',
                aggregateId: qualifyAggregateId('run', id),
                description: 'A described session',
              },
            ]),
            finalizeRun({
              runId: id,
              outcome: 'completed',
            }).pipe(Effect.provide(session)),
          ],
          { concurrency: 'unbounded' },
        );
        expect(
          (yield* Context.get(session, SessionViewAccess).read([id])).runs.get(
            id,
          ),
        ).toMatchObject({
          description: 'A described session',
          status: 'completed',
        });
      }),
  );
  // A model switch that cannot apply fails the run: its end consumes the
  // request, so no resume meets it again.
  it.effect('settles a request the run never applied with its end', () =>
    Effect.gen(function* () {
      yield* Context.get(session, Inbox).send(id, {
        text: '/model gone',
        from: { kind: 'user' },
        control: { kind: 'model', model: 'gone' },
      });
      expect(
        (yield* Context.get(session, Inbox).read(id)).followUps,
      ).toHaveLength(1);
      yield* finalizeRun({ runId: id, outcome: 'failed' }).pipe(
        Effect.provide(session),
      );
      expect((yield* Context.get(session, Inbox).read(id)).followUps).toEqual(
        [],
      );
    }),
  );
});
