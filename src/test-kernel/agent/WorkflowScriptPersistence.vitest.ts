import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readWorkflowScriptCheckpoint,
  runPersistedWorkflowScript,
  runWorkflowScript,
  WorkflowScriptPersistenceError,
  writeWorkflowScriptCheckpoint,
  type WorkflowScriptControl,
  type WorkflowScriptEvent,
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
import { createDeferred } from '@test/support/asyncTestUtils';
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

  it('closes every prior open attempt before a resumed attempt starts', async () => {
    const store = getExecutionStore(executionId);
    const resumeScript = `export const meta = {
  name: 'resume-open-attempt',
  description: 'resume an interrupted attempt',
}
const first = await agent('resume first', { id: 'resume-first' })
const second = await agent('resume second', { id: 'resume-second' })
return [first, second]`;
    const priorRun = await runWorkflowScript({
      script: resumeScript,
      runAgent: async () => 'prior result',
    });
    const interrupted = structuredClone(priorRun.snapshot);
    interrupted.lifecycle = 'active';
    interrupted.timestamps.completedAt = undefined;
    for (const call of interrupted.calls) {
      call.status = 'running';
      call.timestamps.completedAt = undefined;
      call.attempts[0]!.completedAt = undefined;
    }
    interrupted.counts.completed = 0;
    interrupted.counts.running = 2;

    await store.writeMeta({
      timestamp: new Date(0).toISOString(),
      workflow: interrupted,
    });
    const snapshots: WorkflowExecutionSnapshot[] = [];
    const resumed = await runPersistedWorkflowScript({
      store,
      checkpointId: 'resume-open-attempt',
      script: resumeScript,
      initialSnapshot: interrupted,
      runAgent: async () => 'resumed result',
      onSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
        await store.writeMeta({
          timestamp: new Date(0).toISOString(),
          workflow: snapshot,
        });
      },
    });

    expect(snapshots[0]?.calls).toHaveLength(2);
    expect(
      snapshots[0]?.calls.every(
        (call) =>
          call.attempts.length === 1 &&
          call.attempts[0]?.completedAt !== undefined,
      ),
    ).toBe(true);
    expect(
      resumed.snapshot.calls.every(
        (call) =>
          call.attempts.length === 2 &&
          call.attempts.every((attempt) => attempt.completedAt !== undefined),
      ),
    ).toBe(true);
    const persistedSnapshot = WorkflowExecutionSnapshotSchema.parse(
      JSON.parse(JSON.stringify(resumed.snapshot)),
    );
    await expect(store.readMeta()).resolves.toMatchObject({
      workflow: persistedSnapshot,
    });
  });

  it('preserves completed task-plan call files across resume hydrate', async () => {
    const resumeScript = `export const meta = {
  name: 'resume-completed-files',
  description: 'completed planned call keeps files on resume',
  tasks: [{ id: 'planned-call', label: 'Planned call', phase: 'Work' }],
  phases: ['Work'],
}
phase('Work')
return await agent('run planned call', {
  id: 'planned-call',
  inputFiles: ['/workspace/paper.tex'],
  contextFiles: ['/workspace/notes.tex'],
})`;
    const completed = await runWorkflowScript({
      script: resumeScript,
      fingerprintAgentDependencies: async () => 'fingerprint',
      runAgent: async () => 'done',
    });
    expect(completed.snapshot.calls[0]?.status).toBe('completed');
    expect(completed.snapshot.calls[0]?.files).toEqual({
      input: ['paper.tex'],
      context: ['notes.tex'],
      media: [],
    });

    const snapshots: WorkflowExecutionSnapshot[] = [];
    const resumed = await runWorkflowScript({
      script: resumeScript,
      initialSnapshot: completed.snapshot,
      journal: completed.journal,
      fingerprintAgentDependencies: async () => 'fingerprint',
      runAgent: async () => {
        throw new Error('must replay from journal');
      },
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    // Constructor hydrate emits before the script re-issues calls. Reusable
    // completed calls must keep prior files, not the empty meta.tasks stub.
    expect(snapshots[0]?.calls[0]?.files).toEqual({
      input: ['paper.tex'],
      context: ['notes.tex'],
      media: [],
    });
    expect(resumed.snapshot.calls[0]?.status).toBe('cached');
    expect(resumed.snapshot.calls[0]?.files).toEqual({
      input: ['paper.tex'],
      context: ['notes.tex'],
      media: [],
    });
  });

  it('re-runs a skipped planned call with fresh execution timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      let control!: WorkflowScriptControl;
      const resumeScript = `export const meta = {
  name: 'resume-skipped-call',
  description: 'resume a skipped planned call',
  tasks: [{ id: 'planned-call', label: 'Planned call' }],
}
return await agent('run planned call', { id: 'planned-call' })`;
      const skipped = await runWorkflowScript({
        script: resumeScript,
        runAgent: async () => 'must be skipped',
        onControl: (value) => {
          control = value;
        },
        onEvent: (event) => {
          if (event.type === 'agent:start') control.skip(event.index);
        },
      });
      const prior = skipped.snapshot.calls[0]!;
      expect(prior.status).toBe('skipped');
      Object.assign(prior, {
        childExecutionId: 'aaaaaaaaaaaa',
        childStreamId: 'prior#aaaaaaaaaaaa',
        model: 'prior-model',
        costUsd: 1.25,
      });
      Object.assign(prior.attempts[0]!, {
        id: prior.childExecutionId,
        childStreamId: prior.childStreamId,
        model: prior.model,
        costUsd: prior.costUsd,
      });

      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      const runner = vi.fn(async () => 'resumed result');
      const snapshots: WorkflowExecutionSnapshot[] = [];
      const resumed = await runWorkflowScript({
        script: resumeScript,
        initialSnapshot: skipped.snapshot,
        journal: skipped.journal,
        runAgent: runner,
        onSnapshot: async (snapshot) => {
          snapshots.push(snapshot);
        },
      });
      const call = resumed.snapshot.calls[0]!;

      expect(snapshots[0]?.calls[0]?.timestamps).toEqual({
        createdAt: prior.timestamps.createdAt,
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(snapshots[0]?.calls[0]?.childExecutionId).toBeUndefined();
      expect(snapshots[0]?.calls[0]?.childStreamId).toBeUndefined();
      expect(snapshots[0]?.calls[0]?.model).toBeUndefined();
      expect(snapshots[0]?.calls[0]?.costUsd).toBe(1.25);
      expect(snapshots[0]?.calls[0]?.attempts[0]).toMatchObject({
        id: 'aaaaaaaaaaaa',
        childStreamId: 'prior#aaaaaaaaaaaa',
        model: 'prior-model',
        costUsd: 1.25,
      });
      expect(runner).toHaveBeenCalledOnce();
      expect(call.status).toBe('completed');
      expect(call.timestamps.createdAt).toBe(prior.timestamps.createdAt);
      expect(call.timestamps.queuedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(call.timestamps.startedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(call.timestamps.completedAt).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-runs a prior dynamic call with fresh execution timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      const resumeScript = `export const meta = {
  name: 'resume-dynamic-call',
  description: 'resume a prior dynamic call',
}
return await agent('run dynamic call', { id: 'dynamic-call' })`;
      const failed = await runWorkflowScript({
        script: resumeScript,
        runAgent: async (invocation) => {
          invocation.reportChildExecution?.('bbbbbbbbbbbb');
          invocation.reportChildStream?.('prior#bbbbbbbbbbbb');
          invocation.reportModel?.('prior-model');
          invocation.reportCostUsd?.(2.5);
          throw new Error('interrupted');
        },
      });
      const prior = failed.snapshot.calls[0]!;
      expect(prior.status).toBe('failed');

      vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));
      const snapshots: WorkflowExecutionSnapshot[] = [];
      const resumed = await runWorkflowScript({
        script: resumeScript,
        initialSnapshot: failed.snapshot,
        journal: failed.journal,
        runAgent: async () => 'resumed result',
        onSnapshot: async (snapshot) => {
          snapshots.push(snapshot);
        },
      });
      const call = resumed.snapshot.calls[0]!;

      expect(snapshots[0]?.calls[0]?.timestamps).toEqual({
        createdAt: prior.timestamps.createdAt,
        updatedAt: '2026-02-02T00:00:00.000Z',
      });
      expect(snapshots[0]?.calls[0]?.childExecutionId).toBeUndefined();
      expect(snapshots[0]?.calls[0]?.childStreamId).toBeUndefined();
      expect(snapshots[0]?.calls[0]?.model).toBeUndefined();
      expect(snapshots[0]?.calls[0]?.costUsd).toBe(2.5);
      expect(snapshots[0]?.calls[0]?.attempts[0]).toMatchObject({
        id: 'bbbbbbbbbbbb',
        childStreamId: 'prior#bbbbbbbbbbbb',
        model: 'prior-model',
        costUsd: 2.5,
      });
      expect(resumed.result).toBe('resumed result');
      expect(call.status).toBe('completed');
      expect(call.timestamps.createdAt).toBe(prior.timestamps.createdAt);
      expect(call.timestamps.queuedAt).toBe('2026-02-02T00:00:00.000Z');
      expect(call.timestamps.startedAt).toBe('2026-02-02T00:00:00.000Z');
      expect(call.timestamps.completedAt).toBe('2026-02-02T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-runs a cached dynamic call with fresh execution timestamps after its identity changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      const originalScript = `export const meta = {
  name: 'resume-completed-dynamic-call',
  description: 'resume a completed dynamic call after script drift',
}
return await agent('original prompt', { id: 'dynamic-call', model: 'first-model' })`;
      const completed = await runWorkflowScript({
        script: originalScript,
        runAgent: async (invocation) => {
          invocation.reportChildExecution?.('cccccccccccc');
          invocation.reportChildStream?.('prior#cccccccccccc');
          invocation.reportModel?.('prior-model');
          invocation.reportCostUsd?.(3.75);
          return 'original result';
        },
      });
      const cached = await runWorkflowScript({
        script: originalScript,
        initialSnapshot: completed.snapshot,
        journal: completed.journal,
        runAgent: vi.fn(() => Promise.reject(new Error('must replay'))),
      });
      const prior = cached.snapshot.calls[0]!;
      expect(prior.status).toBe('cached');

      vi.setSystemTime(new Date('2026-03-02T00:00:00.000Z'));
      const snapshots: WorkflowExecutionSnapshot[] = [];
      const finishRunner = createDeferred();
      const runnerStarted = createDeferred();
      const runner = vi.fn(async (invocation) => {
        runnerStarted.resolve();
        await finishRunner.promise;
        invocation.reportModel?.('replacement-model');
        throw new Error('replacement failed before reporting cost');
      });
      const resumedRun = runWorkflowScript({
        script: originalScript
          .replace('original prompt', 'changed prompt')
          .replace('first-model', 'changed-model'),
        initialSnapshot: cached.snapshot,
        journal: cached.journal,
        runAgent: runner,
        onSnapshot: async (snapshot) => {
          snapshots.push(snapshot);
        },
      });
      await runnerStarted.promise;
      await Promise.resolve();
      const rerunSnapshots = snapshots.filter((snapshot) =>
        ['queued', 'starting', 'running'].includes(
          snapshot.calls[0]?.status ?? '',
        ),
      );
      const running = rerunSnapshots.find(
        (snapshot) => snapshot.calls[0]?.status === 'running',
      )?.calls[0];
      finishRunner.resolve();
      const resumed = await resumedRun;
      const call = resumed.snapshot.calls[0]!;

      expect(runner).toHaveBeenCalledOnce();
      expect(rerunSnapshots.length).toBeGreaterThan(0);
      for (const snapshot of rerunSnapshots) {
        expect(snapshot.calls[0]?.childExecutionId).toBeUndefined();
        expect(snapshot.calls[0]?.childStreamId).toBeUndefined();
        expect(snapshot.calls[0]?.model).toBeUndefined();
        expect(snapshot.calls[0]?.costUsd).toBe(3.75);
        expect(snapshot.calls[0]?.attempts[0]).toMatchObject({
          id: 'cccccccccccc',
          childStreamId: 'prior#cccccccccccc',
          model: 'prior-model',
          costUsd: 3.75,
        });
      }
      expect(running?.timestamps).toEqual({
        createdAt: prior.timestamps.createdAt,
        queuedAt: '2026-03-02T00:00:00.000Z',
        startedAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
      });
      expect(call.timestamps).toEqual({
        createdAt: prior.timestamps.createdAt,
        queuedAt: '2026-03-02T00:00:00.000Z',
        startedAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        completedAt: '2026-03-02T00:00:00.000Z',
      });
      expect(call).toMatchObject({
        status: 'failed',
        model: 'replacement-model',
        error: 'replacement failed before reporting cost',
      });
      expect(call.childExecutionId).toBeUndefined();
      expect(call.childStreamId).toBeUndefined();
      expect(call.costUsd).toBe(3.75);
      expect(call.attempts).toEqual([
        expect.objectContaining({
          id: 'cccccccccccc',
          childStreamId: 'prior#cccccccccccc',
          model: 'prior-model',
          costUsd: 3.75,
        }),
        expect.objectContaining({ model: 'replacement-model' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears event metadata before an interactive replacement fails early', async () => {
    let control!: WorkflowScriptControl;
    let attempt = 0;
    const events: WorkflowScriptEvent[] = [];
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'retry-metadata',
  description: 'does not report abandoned attempt metadata',
}
return await agent('retry metadata')`,
      runAgent: async (invocation) => {
        attempt += 1;
        if (attempt === 1) {
          invocation.reportModel?.('abandoned-model');
          invocation.reportChildStream?.('writer#aaaaaaaaaaaa');
          await new Promise<void>((_resolve, reject) =>
            invocation.signal.addEventListener(
              'abort',
              () => reject(new Error('retrying')),
              { once: true },
            ),
          );
        }
        throw new Error('replacement failed early');
      },
      onControl: (value) => {
        control = value;
      },
      onEvent: (event) => events.push(event),
    });

    await vi.waitFor(() => expect(attempt).toBe(1));
    control.retry(0);
    await vi.waitFor(() => expect(attempt).toBe(2));
    const result = await run;
    const end = events.findLast((event) => event.type === 'agent:end');

    expect(end).toMatchObject({
      type: 'agent:end',
      outcome: 'failed',
      error: 'replacement failed early',
    });
    expect(end).not.toHaveProperty('model');
    expect(end).not.toHaveProperty('childStreamId');
    expect(result.snapshot.calls[0]?.attempts).toMatchObject([
      {
        number: 1,
        model: 'abandoned-model',
        childStreamId: 'writer#aaaaaaaaaaaa',
      },
      { number: 2 },
    ]);
  });

  it('fails cancellation when an abandoned call returns a non-serializable result during drain', async () => {
    const controller = new AbortController();
    const child = createDeferred<unknown>();
    const runnerStarted = createDeferred();
    const cleanupStarted = createDeferred();
    const snapshots: WorkflowExecutionSnapshot[] = [];
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'abandoned-invalid-result',
  description: 'rejects invalid abandoned output',
}
return await agent('ignores cancellation')`,
      signal: controller.signal,
      runAgent: async (invocation) => {
        runnerStarted.resolve();
        invocation.signal.addEventListener('abort', () =>
          cleanupStarted.resolve(),
        );
        return child.promise;
      },
      onSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    await runnerStarted.promise;
    controller.abort(new Error('cancel requested'));
    await cleanupStarted.promise;
    child.resolve(() => undefined);

    await expect(run).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringMatching(
        /agent\(\) result must be JSON-serializable/i,
      ),
    });
    expect(snapshots.at(-1)).toMatchObject({
      lifecycle: 'failed',
      error: expect.stringMatching(/must be JSON-serializable/i),
    });
  });

  it('keeps the first persistence rejection in time when abandoned writes reject in reverse call order', async () => {
    const writes = Array.from({ length: 2 }, () => {
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
      return { promise, reject };
    });
    const started = [createDeferred(), createDeferred()];
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'reverse-persistence-failures',
  description: 'preserves the first persistence failure in time',
}
agent('first')
agent('second')
return 'guest success'`,
      concurrency: 2,
      runAgent: async ({ prompt }) => prompt,
      onJournalEntry: async ({ index }) => {
        started[index]?.resolve();
        await writes[index]?.promise;
      },
    }).catch((error: unknown) => error);

    await Promise.all(started.map(({ promise }) => promise));
    writes[1]!.reject(new Error('second call rejected first'));
    await Promise.resolve();
    writes[0]!.reject(new Error('first call rejected second'));

    await expect(run).resolves.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining('second call rejected first'),
    });
  });

  it('does not seal while an admitted journal persistence is still pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const snapshots: WorkflowExecutionSnapshot[] = [];
      const child = createDeferred<string>();
      const childStarted = createDeferred();
      const journalWriteStarted = createDeferred();
      const journalWrite = createDeferred();
      let settled = false;
      const run = runWorkflowScript({
        script: `export const meta = {
  name: 'deferred-journal-write',
  description: 'waits for admitted journal persistence',
}
agent('finishes during drain')
return 'guest success'`,
        runAgent: async () => {
          childStarted.resolve();
          return child.promise;
        },
        onJournalEntry: async () => {
          journalWriteStarted.resolve();
          await journalWrite.promise;
        },
        onSnapshot: async (snapshot) => {
          snapshots.push(snapshot);
        },
      });
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await childStarted.promise;
      await vi.advanceTimersByTimeAsync(4_000);
      child.resolve('child result');
      await journalWriteStarted.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(snapshots.at(-1)?.lifecycle).not.toBe('completed');

      journalWrite.resolve();
      const result = await run;
      const terminalWriteCount = snapshots.length;

      expect(result.journal).toHaveLength(1);
      expect(result.snapshot.calls[0]?.status).toBe('completed');
      expect(snapshots.at(-1)).toEqual(result.snapshot);
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshots).toHaveLength(terminalWriteCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('seals snapshots and checkpoints after a late child exceeds drain grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const store = getExecutionStore(executionId);
      const snapshots: WorkflowExecutionSnapshot[] = [];
      const child = createDeferred<string>();
      const started = createDeferred();
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
          started.resolve();
          return child.promise;
        },
        onSnapshot: async (snapshot) => {
          snapshots.push(snapshot);
        },
      });

      await started.promise;
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

      child.resolve('late result');
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
