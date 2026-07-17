import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  readWorkflowScriptCheckpoint,
  runPersistedWorkflowScript,
  WorkflowScriptPersistenceError,
  writeWorkflowScriptCheckpoint,
} from '@agent/workflowScript';
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { workflowScriptCheckpointKvKey } from '@agent/workflowScript/checkpointKey';
import type { ExecutionId } from '@shared/schemas';
import { delay } from '@utils/core';

const executionId = 'aaaaaa111111' as ExecutionId;
const script = `export const meta = {
  name: 'durable-flow',
  description: 'tests durable workflow checkpoints',
}
const first = await agent('first')
const second = await agent('second')
return [first, second]`;

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

beforeEach(() => clearStoreCache());

describe('workflow-script persistence', () => {
  it('replays a completed journal after restart without new agent calls', async () => {
    const store = getExecutionStore(executionId);
    const firstRunner = vi.fn(async ({ prompt }: { prompt: string }) =>
      Promise.resolve(`result:${prompt}`),
    );

    const first = await runPersistedWorkflowScript({
      store,
      checkpointId: 'call-1',
      script,
      runAgent: firstRunner,
    });
    expect(firstRunner).toHaveBeenCalledTimes(2);
    expect(first.journal).toHaveLength(2);

    clearStoreCache();
    const restartedRunner = vi.fn(() => Promise.reject(new Error('live run')));
    const restarted = await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: 'call-1',
      runAgent: restartedRunner,
    });

    expect(restarted.result).toEqual(['result:first', 'result:second']);
    expect(restartedRunner).not.toHaveBeenCalled();
  });

  it('keeps checkpoints isolated by tool call id', async () => {
    const store = getExecutionStore(executionId);
    await runPersistedWorkflowScript({
      store,
      checkpointId: 'call-a',
      script,
      runAgent: async () => 'A',
    });
    await runPersistedWorkflowScript({
      store,
      checkpointId: 'call-b',
      script,
      runAgent: async () => 'B',
    });

    await expect(
      readWorkflowScriptCheckpoint(store, 'call-a'),
    ).resolves.toMatchObject({
      journal: [{ result: 'A' }, { result: 'A' }],
    });
    await expect(
      readWorkflowScriptCheckpoint(store, 'call-b'),
    ).resolves.toMatchObject({
      journal: [{ result: 'B' }, { result: 'B' }],
    });
  });

  it('treats absence as fresh but rejects malformed present state', async () => {
    const store = getExecutionStore(executionId);
    await expect(
      readWorkflowScriptCheckpoint(store, 'missing'),
    ).resolves.toBeNull();

    await store.write(workflowScriptCheckpointKvKey('corrupt'), null);
    await expect(
      readWorkflowScriptCheckpoint(store, 'corrupt'),
    ).rejects.toBeInstanceOf(WorkflowScriptPersistenceError);
    await expect(
      writeWorkflowScriptCheckpoint(store, 'invalid-write', {
        script,
        args: undefined,
        journal: [{ index: 0, key: '0000000000000000', result: () => 1 }],
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptPersistenceError);
  });

  it('accepts script drift: unchanged calls replay, changed calls re-run', async () => {
    const store = getExecutionStore(executionId);
    await runPersistedWorkflowScript({
      store,
      checkpointId: 'stable-call',
      script,
      runAgent: async ({ prompt }) => `v1:${prompt}`,
    });

    clearStoreCache();
    const retryRunner = vi.fn(
      async ({ prompt }: { prompt: string }) => `v2:${prompt}`,
    );
    const evolved = await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: 'stable-call',
      script: script.replace(`agent('second')`, `agent('changed')`),
      runAgent: retryRunner,
    });

    // 'first' is unchanged (same index + prompt hash) so it replays free;
    // only the drifted second call executes live, and the evolved script
    // becomes the stored one.
    expect(retryRunner).toHaveBeenCalledTimes(1);
    expect(evolved.result).toEqual(['v1:first', 'v2:changed']);
    await expect(
      readWorkflowScriptCheckpoint(
        getExecutionStore(executionId),
        'stable-call',
      ),
    ).resolves.toMatchObject({
      script: expect.stringContaining(`agent('changed')`),
    });
  });

  it('round-trips an undefined agent result explicitly', async () => {
    const store = getExecutionStore(executionId);
    const undefinedScript = `export const meta = {
  name: 'undefined-result',
  description: 'persists an undefined result',
}
return await agent('none')`;
    await runPersistedWorkflowScript({
      store,
      checkpointId: 'undefined-result',
      script: undefinedScript,
      runAgent: async () => undefined,
    });

    const raw = await store.read<Record<string, unknown>>(
      workflowScriptCheckpointKvKey('undefined-result'),
    );
    expect(raw).toMatchObject({
      args: { kind: 'undefined' },
      journal: [{ result: { kind: 'undefined' } }],
    });
    await expect(
      readWorkflowScriptCheckpoint(store, 'undefined-result'),
    ).resolves.toMatchObject({ journal: [{ result: undefined }] });
  });

  it('preserves opaque checkpoint ids without normalizing them', async () => {
    const store = getExecutionStore(executionId);
    await writeWorkflowScriptCheckpoint(store, ' call-with-space ', {
      script,
      args: undefined,
      journal: [],
    });

    await expect(
      readWorkflowScriptCheckpoint(store, ' call-with-space '),
    ).resolves.toMatchObject({ script, journal: [] });
    await expect(store.listKeys('workflow-script-')).resolves.toContain(
      workflowScriptCheckpointKvKey(' call-with-space '),
    );
  });

  it('maps maximum-length checkpoint ids to filesystem-safe keys', async () => {
    const store = getExecutionStore(executionId);
    const checkpointId = 'x'.repeat(256);
    const key = workflowScriptCheckpointKvKey(checkpointId);

    expect(Buffer.byteLength(`${encodeURIComponent(key)}.json`)).toBeLessThan(
      256,
    );
    await writeWorkflowScriptCheckpoint(store, checkpointId, {
      script,
      args: undefined,
      journal: [],
    });
    await expect(
      readWorkflowScriptCheckpoint(store, checkpointId),
    ).resolves.toMatchObject({ script, journal: [] });
  });

  it('keeps distinct UTF-16 checkpoint ids on distinct keys', () => {
    expect(workflowScriptCheckpointKvKey('\uD800')).not.toBe(
      workflowScriptCheckpointKvKey('\uFFFD'),
    );
  });

  it('persists arguments and restores them when a restart omits them', async () => {
    const store = getExecutionStore(executionId);
    const argsScript = `export const meta = {
  name: 'args-restart',
  description: 'restores persisted arguments',
}
return await agent(args.topic)`;
    const firstRunner = vi.fn(async ({ prompt }) => `result:${prompt}`);
    await runPersistedWorkflowScript({
      store,
      checkpointId: 'args-restart',
      script: argsScript,
      args: { topic: 'geometry' },
      runAgent: firstRunner,
    });

    const restarted = await runPersistedWorkflowScript({
      store,
      checkpointId: 'args-restart',
      runAgent: vi.fn(() => Promise.reject(new Error('must replay'))),
    });

    expect(restarted.result).toBe('result:geometry');
    await expect(
      readWorkflowScriptCheckpoint(store, 'args-restart'),
    ).resolves.toMatchObject({ args: { topic: 'geometry' } });
  });

  it('adopts new arguments on resume and keeps the journal', async () => {
    const store = getExecutionStore(executionId);
    const argsScript = `export const meta = {
  name: 'args-evolve',
  description: 'adopts evolved arguments',
}
const first = await agent('first')
return [first, args.topic]`;
    await runPersistedWorkflowScript({
      store,
      checkpointId: 'stable-args',
      script: argsScript,
      args: { topic: 'geometry' },
      runAgent: async ({ prompt }) => `v1:${prompt}`,
    });

    clearStoreCache();
    const retryRunner = vi.fn(() => Promise.reject(new Error('live run')));
    const evolved = await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: 'stable-args',
      script: argsScript,
      args: { topic: 'analysis' },
      runAgent: retryRunner,
    });

    // The unchanged agent() call replays; the script sees the new args.
    expect(retryRunner).not.toHaveBeenCalled();
    expect(evolved.result).toEqual(['v1:first', 'analysis']);
  });

  it('validates arguments before creating a checkpoint or launching an agent', async () => {
    const store = getExecutionStore(executionId);
    const runner = vi.fn(async () => 'must not run');

    await expect(
      runPersistedWorkflowScript({
        store,
        checkpointId: 'invalid-args',
        script,
        args: { invalid: () => undefined },
        runAgent: runner,
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptPersistenceError);
    expect(runner).not.toHaveBeenCalled();
    await expect(
      readWorkflowScriptCheckpoint(store, 'invalid-args'),
    ).resolves.toBeNull();
  });

  it('serializes overlapping runs for the same checkpoint', async () => {
    const store = getExecutionStore(executionId);
    const runner = vi.fn(async ({ prompt }) => {
      await delay(10);
      return `result:${prompt}`;
    });

    const [first, second] = await Promise.all([
      runPersistedWorkflowScript({
        store,
        checkpointId: 'overlap',
        script,
        runAgent: runner,
      }),
      runPersistedWorkflowScript({
        store,
        checkpointId: 'overlap',
        script,
        runAgent: runner,
      }),
    ]);

    expect(first.result).toEqual(second.result);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('retains completed entries when the script later throws', async () => {
    const store = getExecutionStore(executionId);
    const failingScript = `export const meta = {
  name: 'partial-run',
  description: 'fails after a completed call',
}
await agent('saved')
throw new Error('script stopped')`;

    await expect(
      runPersistedWorkflowScript({
        store,
        checkpointId: 'partial-run',
        script: failingScript,
        runAgent: async () => 'saved result',
      }),
    ).rejects.toThrow('script stopped');

    await expect(
      readWorkflowScriptCheckpoint(store, 'partial-run'),
    ).resolves.toMatchObject({
      script: failingScript,
      journal: [{ index: 0, result: 'saved result' }],
    });
  });

  it('serializes parallel checkpoint writes before a later script failure', async () => {
    const store = getExecutionStore(executionId);
    const originalWrite = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (key, value) => {
      const journal = (value as { journal?: unknown[] }).journal ?? [];
      if (journal.length === 1) await delay(25);
      await originalWrite(key, value);
    });
    const parallelScript = `export const meta = {
  name: 'parallel-checkpoint',
  description: 'tests checkpoint ordering',
}
await parallel([() => agent('a'), () => agent('b')])
throw new Error('stop after fan-out')`;

    await expect(
      runPersistedWorkflowScript({
        store,
        checkpointId: 'parallel-run',
        script: parallelScript,
        runAgent: async ({ prompt }) => prompt,
      }),
    ).rejects.toThrow('stop after fan-out');

    const checkpoint = await readWorkflowScriptCheckpoint(
      store,
      'parallel-run',
    );
    expect(checkpoint?.journal).toHaveLength(2);
    expect(checkpoint?.journal.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it('aborts when a completed result cannot be checkpointed', async () => {
    const store = getExecutionStore(executionId);
    const originalWrite = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (key, value) => {
      if ((value as { journal?: unknown[] }).journal?.length === 1) {
        throw new Error('storage unavailable');
      }
      await originalWrite(key, value);
    });

    const runner = vi.fn(async () => 'completed child');
    await expect(
      runPersistedWorkflowScript({
        store,
        checkpointId: 'write-failure',
        script,
        runAgent: runner,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowRunAbortError' });
    expect(runner).toHaveBeenCalledOnce();
    await expect(
      readWorkflowScriptCheckpoint(store, 'write-failure'),
    ).resolves.toMatchObject({ journal: [] });
  });

  it('does not launch an agent when the initial checkpoint write fails', async () => {
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'write').mockRejectedValue(new Error('disk full'));
    const runner = vi.fn(async () => 'should not run');

    await expect(
      runPersistedWorkflowScript({
        store,
        checkpointId: 'initial-write-failure',
        script,
        runAgent: runner,
      }),
    ).rejects.toThrow('disk full');
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not let script code suppress a checkpoint failure', async () => {
    const store = getExecutionStore(executionId);
    const originalWrite = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (key, value) => {
      if ((value as { journal?: unknown[] }).journal?.length === 1) {
        throw new Error('checkpoint rejected');
      }
      await originalWrite(key, value);
    });
    const catchesErrors = `export const meta = {
  name: 'catch-errors',
  description: 'tries to catch a checkpoint failure',
}
try {
  await agent('completed')
} catch {}
return 'incorrect success'`;

    await expect(
      runPersistedWorkflowScript({
        store,
        checkpointId: 'caught-write-failure',
        script: catchesErrors,
        runAgent: async () => 'child result',
      }),
    ).rejects.toMatchObject({ name: 'WorkflowRunAbortError' });
  });
});
