import { Effect, Stream, SubscriptionRef } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';
import { z } from 'zod';

import {
  getRunRecords,
  getRunStore,
  isReservedKvKeyName,
} from '@agent/storage';
import { readRunChildren } from '@agent/storage/executionLifecycle';
import { effectRuntime } from '@platform/processRuntime';
import {
  aggregateId,
  AgentConfigFieldsSchema,
  type SessionEventDraft,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
const executionId = 'abcdef';
const streamId = 'stream:abcdef';
let session: ReturnType<typeof createTestSession>;
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  effectRuntime().runPromise(effect);

beforeEach(async () => {
  session = createTestSession();
  await run(
    session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('stream', streamId),
        executionId,
        identity: { kind: 'agent', agent: 'worker' },
        userFollowUpSupport: 'unsupported',
        isRemote: false,
        category: 'toolUse',
        background: false,
      },
    ]),
  );
});

describe('canonical execution records', () => {
  it('preserves private values while display readers drain past their commits', async () => {
    const records = getRunRecords(session, executionId);
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
        const records = getRunRecords(session, executionId);
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
            category: 'toolUse',
            outcome: 'completed',
            response: 'answer',
            files: [],
            cost: 0,
          },
        });
        yield* session.commit([
          {
            type: 'status',
            aggregateId: aggregateId('stream', streamId),
            phase: 'completed',
            cause: 'lifecycle',
          },
        ]);
        expect(yield* records.readReport()).toBe('retained report bytes');
        yield* session.commit([
          {
            type: 'stream.removed',
            aggregateId: aggregateId('stream', streamId),
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
          session.events.aggregate(aggregateId('stream', streamId), 1),
        );
        expect(retained.some((row) => row.type === 'stream.removed')).toBe(
          true,
        );
      }),
  );

  it('resets a prior report explicitly without replacing another metadata value', async () => {
    const records = getRunRecords(session, executionId);
    await run(records.writeReport('old report'));
    await run(records.writeWorkspaceFiles([' a.tex ', 'a.tex', 'b.tex']));
    await run(records.clearReport());
    expect(await run(records.readReport())).toBeNull();
    expect(await run(records.readWorkspaceFiles())).toEqual(['a.tex', 'b.tex']);
  });

  it('preserves malformed-record failures instead of reading a legacy file or a default', async () => {
    const malformed = new z.ZodError([]);
    const reader = Object.create(session) as typeof session;
    reader.readExecutionRecords = () => Effect.die(malformed);
    await getRunStore(executionId).write('meta', {
      timestamp: 'old file',
    });
    const result = await run(
      getRunRecords(reader, executionId).readMeta().pipe(Effect.result),
    );
    expect(result).toMatchObject({ _tag: 'Failure', failure: malformed });
  });

  it('joins child labels through the declared creation edge', async () => {
    const childId = '123abc';
    await run(
      session.commit([
        {
          type: 'run.start',
          aggregateId: aggregateId('stream', 'stream:child'),
          executionId: childId,
          identity: { kind: 'agent', agent: 'assistant' },
          category: 'toolUse',
          background: true,
          userFollowUpSupport: 'unsupported',
          isRemote: false,
          parentStreamId: streamId,
        },
        {
          type: 'execution.launchLabel',
          aggregateId: aggregateId('execution', childId),
          label: 'approved child label',
        },
      ] satisfies SessionEventDraft[]),
    );
    expect(await run(readRunChildren(session, executionId))).toEqual([
      {
        id: childId,
        agent: 'approved child label',
        timestamp: expect.any(String),
      },
    ]);
  });
});

describe('remaining generic execution keys', () => {
  it('reserves only the current turn-state record', () => {
    expect(isReservedKvKeyName('turn-state')).toBe(true);
    for (const key of [
      'meta',
      'config',
      'report',
      'workspace-files',
      'result-meta',
      'child-abcdef',
      'flow_abcdef',
    ])
      expect(isReservedKvKeyName(key)).toBe(false);
  });
});
