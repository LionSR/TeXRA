import { Effect, Stream, SubscriptionRef } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  getExecutionRecords,
  getExecutionStore,
  isReservedKvKeyName,
} from '@agent/storage';
import {
  clearTerminalExecutionState,
  finalizeRun,
  readExecutionChildren,
} from '@agent/storage/executionLifecycle';
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
    const records = getExecutionRecords(session, executionId);
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

  it('resets a prior report explicitly without replacing another metadata value', async () => {
    const records = getExecutionRecords(session, executionId);
    await run(records.writeReport('old report'));
    await run(records.writeWorkspaceFiles([' a.tex ', 'a.tex', 'b.tex']));
    await run(records.clearReport());
    expect(await run(records.readReport())).toBeNull();
    expect(await run(records.readWorkspaceFiles())).toEqual(['a.tex', 'b.tex']);
  });

  it('derives terminal outcome from status and clears it at the resume boundary', async () => {
    const records = getExecutionRecords(session, executionId);
    await run(
      records.writeResultMeta({
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
      }),
    );
    expect(
      await run(
        finalizeRun(session, {
          executionId,
          outcome: 'cancelled',
          flowRecord: 'preserve',
        }),
      ),
    ).toEqual({ ok: true, outcome: 'cancelled' });
    expect(await run(records.readResultMeta())).toMatchObject({
      result: { outcome: 'cancelled' },
    });
    await run(clearTerminalExecutionState(executionId, session));
    expect(await run(records.readMeta())).not.toHaveProperty(
      'outcome',
      'cancelled',
    );
    expect(await run(records.readResultMeta())).toMatchObject({
      result: { outcome: 'completed' },
    });
  });

  it('preserves malformed-record failures instead of reading a legacy file or a default', async () => {
    const malformed = new z.ZodError([]);
    const reader = Object.create(session) as typeof session;
    reader.readExecutionRecords = () => Effect.die(malformed);
    await getExecutionStore(executionId).write('meta', {
      timestamp: 'old file',
    });
    const result = await run(
      getExecutionRecords(reader, executionId).readMeta().pipe(Effect.result),
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
    expect(await run(readExecutionChildren(session, executionId))).toEqual([
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
