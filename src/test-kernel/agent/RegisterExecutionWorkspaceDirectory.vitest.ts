import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getRunRecords, getRunStore } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { runInSession } from '@agent/runtime/RunContext';
import { flowKey } from '@agent/node/persistedFlow';
import {
  finalizeRun,
  acquireResumedRunOwnership,
  registerRun,
} from '@agent/storage/executionLifecycle';
import { inspectRunLease } from '@agent/storage/executionLease';
import { effectRuntime } from '@platform/processRuntime';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace/root' });
const baseConfig = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check the proof.',
  agentCategory: 'toolUse',
});
const executionId = 'abc123';
const options = {
  streamId: 'stream:abc123',
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'nativeInteractive',
} as const;
let session: ReturnType<typeof createTestSession>;
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  effectRuntime().runPromise(effect);
const register = (workingDirectory?: string) =>
  run(
    registerRun(
      session,
      executionId,
      {
        ...baseConfig,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      },
      'chat',
      options,
    ),
  );

beforeEach(() => {
  vi.restoreAllMocks();
  session = createTestSession();
});

describe('execution registration and finalization', () => {
  it.each([undefined, '/workspace/paper '])(
    'pins the execution working directory for %s',
    async (workingDirectory) => {
      await register(workingDirectory);
      expect(
        await run(getRunRecords(session, executionId).readConfig()),
      ).toMatchObject({
        workingDirectory: workingDirectory ?? '/workspace/root',
      });
      expect(
        await run(getRunRecords(session, executionId).readMeta()),
      ).toMatchObject({
        streamId: options.streamId,
        identity: options.identity,
        userFollowUpSupport: 'nativeInteractive',
      });
      expect(await getRunStore(executionId).listKeys()).toEqual([]);
    },
  );

  it('rolls back file ownership when the registration transaction fails', async () => {
    const failure = new Error('database write failed');
    vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
      Effect.die(failure),
    );
    await expect(register()).rejects.toBe(failure);
    expect(
      await runInSession(session, () => inspectRunLease(executionId)),
    ).toEqual({ status: 'free' });
    expect(
      await run(getRunRecords(session, executionId).readMeta()),
    ).toBeNull();
  });

  it.each([false, true])(
    'preserves preexisting file ownership %s when database admission fails',
    async (alreadyOwned) => {
      await register();
      if (!alreadyOwned) await run(session.releaseExecutionLease(executionId));
      const failure = new Error('database admission rejected');
      vi.spyOn(session, 'acquireExecutionClaims').mockReturnValueOnce(
        Effect.fail(failure),
      );
      await expect(
        run(acquireResumedRunOwnership(session, executionId, options.streamId)),
      ).rejects.toBe(failure);
      const lease = await runInSession(session, () =>
        inspectRunLease(executionId),
      );
      expect(lease.status).toBe(alreadyOwned ? 'owned' : 'free');
    },
  );

  it('releases reacquired database claims when repeated registration fails', async () => {
    await register();
    await run(session.releaseExecutionLease(executionId));
    const failure = new Error('registration rejected');
    vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
      Effect.die(failure),
    );
    await expect(register()).rejects.toBe(failure);
    await expect(
      run(getRunRecords(session, executionId).writeReport('unowned')),
    ).rejects.toThrow();
    await run(session.acquireExecutionClaims(executionId, options.streamId));
    await run(getRunRecords(session, executionId).writeReport('owned'));
    expect(await run(getRunRecords(session, executionId).readReport())).toBe(
      'owned',
    );
  });

  it('keeps the existing local run claimed when a new birth collides with its stream', async () => {
    await register();
    await expect(
      run(registerRun(session, 'bcd234', baseConfig, 'chat', options)),
    ).rejects.toThrow();
    await run(getRunRecords(session, executionId).writeReport('still owned'));
    expect(await run(getRunRecords(session, executionId).readReport())).toBe(
      'still owned',
    );
  });

  it('releases fresh birth claims when the committed publication consumer fails', async () => {
    vi.spyOn(session, 'receiveCommittedEvent').mockReturnValue(
      Effect.die(new Error('consumer failed')),
    );
    await expect(register()).rejects.toThrow();
    expect(
      await run(getRunRecords(session, executionId).readMeta()),
    ).not.toBeNull();
    await expect(
      run(getRunRecords(session, executionId).writeReport('unowned')),
    ).rejects.toThrow();
    expect(
      await runInSession(session, () => inspectRunLease(executionId)),
    ).toEqual({ status: 'free' });
  });

  it.each(['preserve', 'delete'] as const)(
    'retains the existing requested checkpoint disposition %s',
    async (flowRecord) => {
      await register();
      const store = getRunStore(executionId);
      await runInSession(session, () =>
        store.write(flowKey(executionId), { checkpoint: 'existing format' }),
      );
      expect(
        await run(
          finalizeRun(session, {
            executionId,
            outcome: 'completed',
            flowRecord,
          }),
        ),
      ).toEqual({ ok: true, outcome: 'completed' });
      expect(
        await runInSession(session, () => store.exists(flowKey(executionId))),
      ).toBe(flowRecord === 'preserve');
    },
  );

  it.each([
    { statusFails: true, deletionFails: false },
    { statusFails: true, deletionFails: true },
    { statusFails: false, deletionFails: true },
  ])(
    'preserves independent finalization failures $statusFails/$deletionFails',
    async ({ statusFails, deletionFails }) => {
      await register();
      const statusFailure = new Error('status write failed');
      const deletionFailure = new Error('checkpoint delete failed');
      if (statusFails)
        vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
          Effect.die(statusFailure),
        );
      const deletion = vi.spyOn(getRunStore(executionId), 'delete');
      if (deletionFails) deletion.mockRejectedValueOnce(deletionFailure);
      const result = await run(
        finalizeRun(session, {
          executionId,
          outcome: 'failed',
          flowRecord: 'delete',
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        outcomePersisted: !statusFails,
      });
      expect(deletion).toHaveBeenCalledWith(flowKey(executionId));
      const singleFailure = statusFails ? statusFailure : deletionFailure;
      if (!result.ok)
        expect(result.error).toEqual(
          statusFails && deletionFails
            ? new AggregateError(
                [statusFailure, deletionFailure],
                `Terminal status and flow deletion failed for ${executionId}`,
              )
            : singleFailure,
        );
    },
  );
});
