import { Effect, Stream, SubscriptionRef } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';

import { getRunRecords } from '@agent/storage';
import {
  aggregateId,
  AgentConfigFieldsSchema,
  type RunId,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
const runId = 'abcdef' as RunId;
let session: ReturnType<typeof createTestSession>;
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  testRuntime().runPromise(effect);

beforeEach(async () => {
  session = createTestSession();
  await run(
    session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', runId),
        identity: { kind: 'agent', agent: 'worker' },
        userFollowUpSupport: 'unsupported',
        isRemote: false,
        category: 'toolUse',
        parent: null,
      },
    ]),
  );
});

describe('canonical run records', () => {
  it('preserves private values while display readers drain past their commits', async () => {
    const records = getRunRecords(session, runId);
    const config = AgentConfigFieldsSchema.parse({
      agent: 'worker',
      agentCategory: 'toolUse',
      instruction: 'private instruction',
    });
    await run(records.writeRunRecord(config));
    await run(records.writeReport('private report'));
    expect(await run(records.readConfig())).toEqual(config);
    expect(await run(records.readReport())).toBe('private report');
    const visible = await run(Stream.runCollect(session.events.listing()));
    expect(visible.map((event) => event.type)).toEqual(['run.start']);
    expect(SubscriptionRef.getUnsafe(session.view).cursor).toBe(session.now());
  });

  it.effect(
    'hides all private records at deletion while their rows await collection',
    () =>
      Effect.gen(function* () {
        const records = getRunRecords(session, runId);
        yield* records.writeRunRecord(
          AgentConfigFieldsSchema.parse({
            agent: 'worker',
            agentCategory: 'toolUse',
          }),
        );
        yield* records.writeReport('retained report bytes');
        yield* records.writeWorkspaceFiles(['output.tex']);
        yield* records.writeResultMeta({
          producer: 'subagent',
          agentName: 'worker',
          wallTimeMs: 1,
          output: {
            category: 'toolUse',
            response: 'answer',
            files: [],
          },
        });
        yield* session.commit([
          {
            type: 'run.end',
            aggregateId: aggregateId('run', runId),
            outcome: 'completed',
            output: { category: 'toolUse', response: '', files: [] },
          },
        ]);
        expect(yield* records.readReport()).toBe('retained report bytes');
        yield* session.commit([
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
        const retained = yield* Stream.runCollect(
          session.events.aggregate(aggregateId('run', runId), 1),
        );
        expect(retained.some((row) => row.type === 'run.removed')).toBe(true);
      }),
  );

  it('resets a prior report explicitly without replacing another metadata value', async () => {
    const records = getRunRecords(session, runId);
    await run(records.writeReport('old report'));
    await run(records.writeWorkspaceFiles([' a.tex ', 'a.tex', 'b.tex']));
    await run(records.clearReport());
    expect(await run(records.readReport())).toBeNull();
    expect(await run(records.readWorkspaceFiles())).toEqual(['a.tex', 'b.tex']);
  });
});
