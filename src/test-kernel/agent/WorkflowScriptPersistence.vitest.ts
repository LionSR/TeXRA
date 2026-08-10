import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readWorkflowScriptCheckpoint,
  runPersistedWorkflowScript,
  WorkflowScriptPersistenceError,
  writeWorkflowScriptCheckpoint,
} from '@agent/workflowScript';
import {
  clearStoreCache,
  getExecutionStore,
  type ExecutionKVStore,
} from '@agent/storage';
import { workflowScriptCheckpointKvKey } from '@agent/workflowScript/checkpointKey';
import {
  WorkflowExecutionSnapshotSchema,
  type ExecutionId,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { delay } from '@utils/core';

const executionId = 'aaaaaa111111' as ExecutionId;
const EMPTY_FILES = { inputFiles: [], contextFiles: [], mediaFiles: [] };
const script = `export const meta = {
  name: 'durable-flow',
  description: 'tests durable workflow checkpoints',
}
const first = await agent('first')
const second = await agent('second')
return [first, second]`;
setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

beforeEach(() => clearStoreCache());

// Runs `onFirstEntry` while the checkpoint holding exactly one journal entry
// is being written; throwing from it leaves that write unperformed.
function interceptFirstEntryWrite(
  store: ExecutionKVStore,
  onFirstEntry: () => Promise<void>,
): void {
  const originalWrite = store.write.bind(store);
  vi.spyOn(store, 'write').mockImplementation(async (key, value) => {
    if ((value as { journal?: unknown[] }).journal?.length === 1) {
      await onFirstEntry();
    }
    await originalWrite(key, value);
  });
}

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
    expect(restarted.snapshot.counts.cached).toBe(2);
    await expect(
      readWorkflowScriptCheckpoint(getExecutionStore(executionId), 'call-1'),
    ).resolves.toMatchObject({
      journal: [{ result: 'result:first' }, { result: 'result:second' }],
    });
    expect(restartedRunner).not.toHaveBeenCalled();
  });

  it('persists and hydrates runtime-valid unbounded snapshot fields', async () => {
    const store = getExecutionStore(executionId);
    const longId = `call-${'i'.repeat(2_500)}`;
    const longPhase = `Phase ${'p'.repeat(3_000)}`;
    const longError = `failure-${'e'.repeat(4_000)}`;
    const files = Array.from(
      { length: 513 },
      (_, index) => `/workspace/${'f'.repeat(600)}-${index}.tex`,
    );
    const snapshots: WorkflowExecutionSnapshot[] = [];
    const adversarialScript = `export const meta = {
  name: 'unbounded-snapshot',
  description: 'persists runtime-valid snapshot fields',
}
phase(${JSON.stringify(longPhase)})
return await agent('fail after snapshotting', {
  id: ${JSON.stringify(longId)},
  label: '   ',
  inputFiles: ${JSON.stringify(files)},
})`;

    const result = await runPersistedWorkflowScript({
      store,
      checkpointId: 'unbounded-snapshot',
      script: adversarialScript,
      fingerprintAgentDependencies: async () => 'fingerprint',
      runAgent: async () => {
        throw new Error(longError);
      },
      onSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    expect(result.snapshot.calls[0]).toMatchObject({
      id: longId,
      label: '',
      error: longError,
    });
    expect(result.snapshot.stages[0]?.title).toBe(longPhase);
    expect(result.snapshot.calls[0]?.files.input).toHaveLength(513);
    expect(result.snapshot.calls[0]?.files.input[0]?.length).toBeGreaterThan(
      512,
    );
    expect(() =>
      WorkflowExecutionSnapshotSchema.parse(result.snapshot),
    ).not.toThrow();
    expect(snapshots.at(-1)).toEqual(result.snapshot);

    const hydrated = await runPersistedWorkflowScript({
      store,
      checkpointId: 'unbounded-snapshot',
      initialSnapshot: result.snapshot,
      fingerprintAgentDependencies: async () => 'fingerprint',
      runAgent: async () => {
        throw new Error(longError);
      },
    });
    expect(hydrated.snapshot.calls[0]).toMatchObject({
      id: longId,
      label: '',
      error: longError,
    });
    expect(hydrated.snapshot.stages[0]?.title).toBe(longPhase);
    expect(hydrated.snapshot.calls[0]?.files.input).toHaveLength(513);
    expect(() =>
      WorkflowExecutionSnapshotSchema.parse(hydrated.snapshot),
    ).not.toThrow();
  });

  it('seals snapshots and checkpoints after a late child exceeds drain grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const store = getExecutionStore(executionId);
      const snapshots: WorkflowExecutionSnapshot[] = [];
      let resolveChild!: (value: string) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const child = new Promise<string>((resolve) => {
        resolveChild = resolve;
      });
      const run = runPersistedWorkflowScript({
        store,
        checkpointId: 'late-sealed-child',
        script: `export const meta = {
  name: 'late-sealed-child',
  description: 'late sealed child',
}
agent('ignores cancellation')
return 'guest success'`,
        runAgent: async () => {
          markStarted();
          return child;
        },
        onSnapshot: async (snapshot) => {
          snapshots.push(snapshot);
        },
      });

      await started;
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await run;
      const terminalWriteCount = snapshots.length;
      const terminalSnapshot = snapshots.at(-1);
      expect(terminalSnapshot).toEqual(result.snapshot);
      expect(terminalSnapshot?.calls[0]?.attempts[0]?.completedAt).toEqual(
        expect.any(String),
      );
      expect(() =>
        WorkflowExecutionSnapshotSchema.parse(result.snapshot),
      ).not.toThrow();
      await expect(
        readWorkflowScriptCheckpoint(store, 'late-sealed-child'),
      ).resolves.toMatchObject({ journal: [] });

      resolveChild('late result');
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(snapshots).toHaveLength(terminalWriteCount);
      expect(snapshots.at(-1)).toEqual(result.snapshot);
      expect(result.journal).toEqual([]);
      await expect(
        readWorkflowScriptCheckpoint(store, 'late-sealed-child'),
      ).resolves.toMatchObject({ journal: [] });
    } finally {
      vi.useRealTimers();
    }
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
        files: EMPTY_FILES,
        journal: [
          {
            index: 0,
            key: '0000000000000000',
            result: () => 1,
          },
        ],
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
      files: EMPTY_FILES,
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
      files: EMPTY_FILES,
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

  it('persists launch files and restores them when a restart omits them', async () => {
    const store = getExecutionStore(executionId);
    const inputScript = `export const meta = {
  name: 'inputs-restart',
  description: 'restores persisted launch files',
}
return files`;
    await runPersistedWorkflowScript({
      store,
      checkpointId: 'inputs-restart',
      script: inputScript,
      files: {
        inputFiles: ['paper.tex'],
        contextFiles: ['notes.tex'],
        mediaFiles: ['figure.pdf'],
      },
      runAgent: vi.fn(),
    });

    const restarted = await runPersistedWorkflowScript({
      store,
      checkpointId: 'inputs-restart',
      runAgent: vi.fn(),
    });

    expect(restarted.result).toEqual({
      inputFiles: ['paper.tex'],
      contextFiles: ['notes.tex'],
      mediaFiles: ['figure.pdf'],
    });
    await expect(
      readWorkflowScriptCheckpoint(store, 'inputs-restart'),
    ).resolves.toMatchObject({
      files: {
        inputFiles: ['paper.tex'],
        contextFiles: ['notes.tex'],
        mediaFiles: ['figure.pdf'],
      },
    });
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
    interceptFirstEntryWrite(store, () => delay(25));
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
    interceptFirstEntryWrite(store, () =>
      Promise.reject(new Error('storage unavailable')),
    );

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
    interceptFirstEntryWrite(store, () =>
      Promise.reject(new Error('checkpoint rejected')),
    );
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
