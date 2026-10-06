import { Effect, Stream, SubscriptionRef } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { getRunRecords } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  AgentConfigFieldsSchema,
  type RunId,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedRunRecord, seedReport } from '@test/support/runRecordSeeds';

setupPlatform({ workspacePath: '/workspace' });
const runId = 'abcdef' as RunId;
let session: SessionHandle;
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  testRuntime().runPromise(effect);

beforeEach(async () => {
  session = await Effect.runPromise(createTestSession());
  await run(
    session.log.transact([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', runId),
        identity: { kind: 'agent', agent: 'worker' },
        userFollowUpSupport: 'unsupported',
        parent: null,
        provenance: null,
      },
    ]),
  );
});

describe('canonical run records', () => {
  it('preserves private values while display readers drain past their commits', async () => {
    const records = getRunRecords(session, runId);
    const config = AgentConfigFieldsSchema.parse({
      agent: 'worker',
      instruction: 'private instruction',
    });
    await run(seedRunRecord(session, runId, config));
    await run(seedReport(session, runId, 'private report'));
    expect(await run(records.readConfig())).toEqual(config);
    expect(await run(records.readReport())).toBe('private report');
    const visible = await run(Stream.runCollect(session.log.listing()));
    // The configuration is the run's one `run.config` display row; the
    // report stays private.
    expect(visible.map((event) => event.type)).toEqual([
      'run.start',
      'run.config',
    ]);
    expect(SubscriptionRef.getUnsafe(session.view.ref).cursor).toBe(
      session.log.now(),
    );
  });

  it.effect(
    'hides all private records at deletion while their rows await collection',
    () =>
      Effect.gen(function* () {
        const records = getRunRecords(session, runId);
        yield* seedRunRecord(
          session,
          runId,
          AgentConfigFieldsSchema.parse({
            agent: 'worker',
          }),
        );
        yield* seedReport(session, runId, 'retained report bytes');
        yield* records.writeResultMeta({
          producer: 'subagent',
          agentName: 'worker',
          wallTimeMs: 1,
          output: { response: 'done', files: [] },
        });
        yield* session.log.transact([
          {
            type: 'run.end',
            aggregateId: aggregateId('run', runId),
            outcome: 'completed',
            output: { response: '', files: [] },
          },
        ]);
        expect(yield* records.readReport()).toBe('retained report bytes');
        // The result joins the terminal fact to the reply the delivery
        // recorded, and drops the producer's own context.
        expect(yield* records.readResult()).toEqual({
          outcome: 'completed',
          output: { response: 'done', files: [] },
        });
        yield* session.log.transact([
          {
            type: 'run.removed',
            aggregateId: aggregateId('run', runId),
          },
        ]);
        expect(
          yield* Effect.all([
            records.exists(),
            records.readRunRecord(),
            records.readReport(),
            records.readWorkspaceFiles(),
            records.readResultMeta(),
          ]),
        ).toEqual([false, null, null, [], null]);
        const retained = yield* session.log.rows(aggregateId('run', runId));
        expect(retained.some((row) => row.type === 'run.removed')).toBe(true);
      }),
  );
});
