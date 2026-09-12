import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getRunRecords } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { runInSession } from '@agent/runtime/RunContext';
import {
  finalizeRun,
  acquireResumedRunOwnership,
  registerRun,
} from '@agent/storage/runLifecycle';
import { inspectRunLease } from '@agent/storage/runLease';
import { effectRuntime } from '@platform/processRuntime';
import { aggregateId, type RunId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace/root' });
const baseConfig = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check the proof.',
  agentCategory: 'toolUse',
});
const runId = 'abc123' as RunId;
const options = {
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
      runId,
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

describe('run registration and finalization', () => {
  it.each([undefined, '/workspace/paper '])(
    'pins the run working directory for %s',
    async (workingDirectory) => {
      await register(workingDirectory);
      expect(
        await run(getRunRecords(session, runId).readConfig()),
      ).toMatchObject({
        workingDirectory: workingDirectory ?? '/workspace/root',
      });
      expect(
        (await run(session.readView([runId]))).runs.get(runId),
      ).toMatchObject({
        identity: options.identity,
        followUpSupport: 'nativeInteractive',
      });
    },
  );

  it('rolls back file ownership when the registration transaction fails', async () => {
    const failure = new Error('database write failed');
    vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
      Effect.die(failure),
    );
    await expect(register()).rejects.toBe(failure);
    expect(await runInSession(session, () => inspectRunLease(runId))).toEqual({
      status: 'free',
    });
    expect(await run(getRunRecords(session, runId).exists())).toBe(false);
  });

  it.each([false, true])(
    'preserves preexisting file ownership %s when database admission fails',
    async (alreadyOwned) => {
      await register();
      if (!alreadyOwned) await run(session.releaseRunLease(runId));
      const failure = new Error('database admission rejected');
      vi.spyOn(session, 'acquireClaims').mockReturnValueOnce(
        Effect.fail(failure),
      );
      await expect(
        run(acquireResumedRunOwnership(session, runId)),
      ).rejects.toBe(failure);
      const lease = await runInSession(session, () => inspectRunLease(runId));
      expect(lease.status).toBe(alreadyOwned ? 'owned' : 'free');
    },
  );

  it('releases reacquired database claims when repeated registration fails', async () => {
    await register();
    await run(session.releaseRunLease(runId));
    const failure = new Error('registration rejected');
    vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
      Effect.die(failure),
    );
    await expect(register()).rejects.toBe(failure);
    await expect(
      run(getRunRecords(session, runId).writeReport('unowned')),
    ).rejects.toThrow();
    await run(session.acquireClaims(aggregateId('run', runId)));
    await run(getRunRecords(session, runId).writeReport('owned'));
    expect(await run(getRunRecords(session, runId).readReport())).toBe('owned');
  });

  it('releases fresh birth claims when the committed publication consumer fails', async () => {
    vi.spyOn(session, 'receiveCommittedEvent').mockReturnValue(
      Effect.die(new Error('consumer failed')),
    );
    await expect(register()).rejects.toThrow();
    expect(await run(getRunRecords(session, runId).exists())).toBe(true);
    await expect(
      run(getRunRecords(session, runId).writeReport('unowned')),
    ).rejects.toThrow();
    expect(await runInSession(session, () => inspectRunLease(runId))).toEqual({
      status: 'free',
    });
  });

  it('reports a terminal status write that failed, and persists nothing', async () => {
    await register();
    const failure = new Error('status write failed');
    vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
      Effect.die(failure),
    );
    // The run's rows live until explicit deletion (C9): finalization writes
    // the terminal row and removes nothing beside it, so a failed write is
    // the whole failure and comes back unwrapped.
    const result = await run(
      finalizeRun(session, { runId, outcome: 'failed' }),
    );
    expect(result).toMatchObject({ ok: false, outcomePersisted: false });
    if (!result.ok) expect(result.error).toBe(failure);
  });
});
