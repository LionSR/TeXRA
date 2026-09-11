import { Effect, Stream, SubscriptionRef } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';
import { z } from 'zod';

import {
  getRunRecords,
  getRunStore,
  isReservedKvKeyName,
} from '@agent/storage';
import { readRunChildren } from '@agent/storage/runLifecycle';
import { effectRuntime } from '@platform/processRuntime';
import {
  aggregateId,
  AgentConfigFieldsSchema,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
const runId = 'abcdef' as RunId;
let session: ReturnType<typeof createTestSession>;
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  effectRuntime().runPromise(effect);

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
          result: {
            outcome: 'completed',
            output: {
              category: 'toolUse',
              response: 'answer',
              files: [],
            },
          },
        });
        yield* session.commit([
          {
            type: 'status',
            aggregateId: aggregateId('run', runId),
            phase: 'completed',
            cause: 'lifecycle',
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
            records.readMeta(),
            records.readRunRecord(),
            records.readReport(),
            records.readWorkspaceFiles(),
            records.readResultMeta(),
          ]),
        ).toEqual([null, null, null, [], null]);
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

  it('preserves malformed-record failures instead of reading a legacy file or a default', async () => {
    const malformed = new z.ZodError([]);
    const reader = Object.create(session) as typeof session;
    reader.readRunRecords = () => Effect.die(malformed);
    await getRunStore(runId).write('meta', {
      timestamp: 'old file',
    });
    const result = await run(
      getRunRecords(reader, runId).readMeta().pipe(Effect.result),
    );
    expect(result).toMatchObject({ _tag: 'Failure', failure: malformed });
  });

  it('joins child labels through the declared creation edge', async () => {
    const childId = '123abc' as RunId;
    await run(
      session.commit([
        {
          type: 'run.start',
          aggregateId: aggregateId('run', childId),
          identity: { kind: 'agent', agent: 'assistant' },
          category: 'toolUse',
          userFollowUpSupport: 'unsupported',
          isRemote: false,
          parent: { id: runId },
        },
        {
          type: 'run.launchLabel',
          aggregateId: aggregateId('run', childId),
          label: 'approved child label',
        },
      ] satisfies SessionEventDraft[]),
    );
    expect(await run(readRunChildren(session, runId))).toEqual([
      {
        id: childId,
        agent: 'approved child label',
        timestamp: expect.any(String),
      },
    ]);
  });
});
