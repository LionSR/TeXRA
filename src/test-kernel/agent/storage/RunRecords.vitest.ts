import { Effect, Schema, SubscriptionRef, Context } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import {
  AgentConfigSchema,
  qualifyAggregateId,
  type RunId,
} from '@texra-ai/harness/schemas';
import { getRunRecords } from '@agent/storage/runRecords';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedRunRecord, seedReport } from '@test/support/runRecordSeeds';

setupPlatform({ workspacePath: '/workspace' });
const runId = 'abcdef' as RunId;
let session: Context.Context<SessionServices>;
const run = <A, E>(effect: Effect.Effect<A, E, SessionServices>) =>
  testRuntime().runPromise(effect.pipe(Effect.provide(session)));

beforeEach(async () => {
  session = await Effect.runPromise(createTestSession());
  await run(
    Context.get(session, SessionLog).transact([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', runId),
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
    const records = getRunRecords(runId);
    const config = Schema.decodeUnknownSync(AgentConfigSchema)({
      agent: 'worker',
      instruction: 'private instruction',
    });
    await run(seedRunRecord(session, runId, config));
    await run(seedReport(session, runId, 'private report'));
    expect(await run(records.readConfig())).toEqual(config);
    expect(await run(records.readReport())).toBe('private report');
    const visible = await run(Context.get(session, SessionLog).display(runId));
    // The configuration is the run's one `run.config` display row; the
    // report stays private.
    expect(visible.map((event) => event.type)).toEqual([
      'run.start',
      'run.config',
    ]);
    expect(
      SubscriptionRef.getUnsafe(Context.get(session, SessionViewAccess).ref)
        .cursor,
    ).toBe(Context.get(session, SessionLog).now());
  });

  it.effect(
    'hides all private records at deletion while their rows await collection',
    () =>
      Effect.gen(function* () {
        const records = getRunRecords(runId);
        yield* seedRunRecord(
          session,
          runId,
          Schema.decodeUnknownSync(AgentConfigSchema)({
            agent: 'worker',
          }),
        );
        yield* seedReport(session, runId, 'retained report bytes');
        yield* Context.get(session, SessionLog).transact([
          {
            type: 'run.result',
            aggregateId: qualifyAggregateId('run', runId),
            result: {
              producer: 'subagent',
              output: { response: 'done', files: [] },
            },
          },
        ]);
        yield* Context.get(session, SessionLog).transact([
          {
            type: 'run.end',
            aggregateId: qualifyAggregateId('run', runId),
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
        yield* Context.get(session, SessionLog).transact([
          {
            type: 'run.removed',
            aggregateId: qualifyAggregateId('run', runId),
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
        const retained = yield* Context.get(session, SessionLog).runRows(
          qualifyAggregateId('run', runId),
          'input',
        );
        expect(retained.removed).not.toBeNull();
      }).pipe(Effect.provide(session)),
  );
});
