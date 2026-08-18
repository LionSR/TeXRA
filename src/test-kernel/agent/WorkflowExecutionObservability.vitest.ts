import { describe, expect, it, vi } from 'vitest';

import {
  WORKFLOW_SKIPPED_RESULT,
  runWorkflowScript,
  type WorkflowAgentInvocation,
  type WorkflowScriptControl,
} from '@agent/workflowScript';
import {
  WorkflowExecutionSnapshotSchema,
  deriveWorkflowCounts,
  type ExecutionId,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';

const META = `export const meta = {
  name: 'observable',
  description: 'observable workflow',
  phases: ['Draft', 'Review'],
  tasks: [
    { id: 'draft', label: 'Draft', phase: 'Draft' },
    { id: 'review', label: 'Review', phase: 'Review' },
  ],
}
`;

function finalSnapshot(snapshots: readonly WorkflowExecutionSnapshot[]) {
  return snapshots.at(-1)!;
}

function recordingSnapshots(): {
  snapshots: WorkflowExecutionSnapshot[];
  onSnapshot: (snapshot: WorkflowExecutionSnapshot) => void;
} {
  const snapshots: WorkflowExecutionSnapshot[] = [];
  return {
    snapshots,
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
  };
}

describe('workflow execution observability', () => {
  it('keeps later tasks stage-blocked, advances stages monotonically, and skips unreached work', async () => {
    const { snapshots, onSnapshot } = recordingSnapshots();
    const result = await runWorkflowScript({
      script: `${META}phase('Draft')
await agent('draft privately', { id: 'draft' })
return 'done'`,
      runAgent: async () => 'done',
      onSnapshot,
    });

    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.calls.find((call) => call.id === 'review')?.status ===
          'stageBlocked',
      ),
    ).toBe(true);
    // Drain-time cloning: every delivered snapshot is its own isolated copy.
    expect(new Set(snapshots).size).toBe(snapshots.length);
    expect(result.snapshot.stages.map((stage) => stage.lifecycle)).toEqual([
      'completed',
      'skipped',
    ]);
    expect(result.snapshot.calls.map((call) => call.status)).toEqual([
      'completed',
      'skipped',
    ]);
    expect(result.snapshot.currentStageId).toBeUndefined();
    expect(() =>
      WorkflowExecutionSnapshotSchema.parse(result.snapshot),
    ).not.toThrow();
    const openTerminalAttempt = structuredClone(result.snapshot);
    openTerminalAttempt.calls[0]!.attempts[0]!.completedAt = undefined;
    expect(
      WorkflowExecutionSnapshotSchema.safeParse(openTerminalAttempt).success,
    ).toBe(false);

    const { snapshots: failedSnapshots, onSnapshot: failedOnSnapshot } =
      recordingSnapshots();
    await expect(
      runWorkflowScript({
        script: `${META}phase('Review')
phase('Draft')
return null`,
        runAgent: async () => 'unused',
        onSnapshot: failedOnSnapshot,
      }),
    ).rejects.toThrow(/monotonically/);
    expect(finalSnapshot(failedSnapshots).lifecycle).toBe('failed');
  });

  it('rejects empty structural identities, titles, and stage references', async () => {
    const { snapshots, onSnapshot } = recordingSnapshots();
    const result = await runWorkflowScript({
      script: `export const meta = {
  name: 'structural-fields',
  description: 'structural field validation',
  phases: ['Work'],
}
phase('Work')
return await agent('work', { id: 'work-call' })`,
      runAgent: async (invocation) => {
        invocation.report?.({ childExecutionId: 'aaaaaaaaaaaa' });
        return 'done';
      },
      onSnapshot,
    });

    const expectEmptyFieldRejected = (
      mutate: (snapshot: WorkflowExecutionSnapshot) => void,
    ): void => {
      const candidate = structuredClone(result.snapshot);
      mutate(candidate);
      expect(WorkflowExecutionSnapshotSchema.safeParse(candidate).success).toBe(
        false,
      );
    };

    expectEmptyFieldRejected((candidate) => {
      candidate.stages[0]!.id = '';
      candidate.calls[0]!.stageId = '';
    });
    expectEmptyFieldRejected((candidate) => {
      candidate.stages[0]!.title = '';
    });
    expectEmptyFieldRejected((candidate) => {
      candidate.calls[0]!.id = '';
    });
    expectEmptyFieldRejected((candidate) => {
      candidate.calls[0]!.attempts[0]!.id = '' as ExecutionId;
    });

    // A meta.json persisted before stageTitle was removed still carries the
    // key on disk; the read path must tolerate it rather than fail closed.
    const legacy = structuredClone(result.snapshot) as unknown as {
      calls: Array<Record<string, unknown>>;
    };
    legacy.calls[0]!.stageTitle = 'Work';
    const legacyParsed = WorkflowExecutionSnapshotSchema.safeParse(legacy);
    expect(legacyParsed.success).toBe(true);
    expect(
      (legacyParsed.data?.calls[0] as { stageTitle?: unknown } | undefined)
        ?.stageTitle,
    ).toBeUndefined();

    const active = structuredClone(
      snapshots.find(
        (snapshot) =>
          snapshot.currentStageId !== undefined &&
          snapshot.calls[0]?.status === 'running',
      )!,
    );
    active.stages[0]!.id = '';
    active.calls[0]!.stageId = '';
    active.currentStageId = '';
    expect(WorkflowExecutionSnapshotSchema.safeParse(active).success).toBe(
      false,
    );
  });

  it('records queued work before admission and starts attempts only inside the queue slot', async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn(async (invocation: WorkflowAgentInvocation) => {
      if (invocation.index === 0) await firstRun;
      return 'done';
    });
    const { snapshots, onSnapshot } = recordingSnapshots();
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'queue',
  description: 'queue observation',
}
return await parallel([
  () => agent('first secret', { id: 'first', label: 'First' }),
  () => agent('second secret', { id: 'second', label: 'Second' }),
])`,
      concurrency: 1,
      runAgent: runner,
      onSnapshot,
    });

    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
      expect(
        snapshots.some(
          (snapshot) =>
            snapshot.calls[0]?.status === 'running' &&
            snapshot.calls[1]?.status === 'queued' &&
            snapshot.calls[1]?.attempts.length === 0,
        ),
      ).toBe(true);
    });
    release();
    const result = await run;
    expect(deriveWorkflowCounts(result.snapshot.calls).completed).toBe(2);
    expect(
      result.snapshot.calls.every((call) => call.attempts.length === 1),
    ).toBe(true);
  });

  it('tracks retry attempts, interactive skip, cached replay, and failure-continue', async () => {
    let control!: WorkflowScriptControl;
    let attempts = 0;
    const releases: Array<() => void> = [];
    const retryRun = runWorkflowScript({
      script: `export const meta = {
  name: 'retry',
  description: 'retry observation',
}
return await agent('retry secret', { label: 'Retry task' })`,
      runAgent: async (invocation) => {
        attempts += 1;
        invocation.report?.({
          childExecutionId: attempts === 1 ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb',
        });
        await new Promise<void>((resolve, reject) => {
          releases.push(resolve);
          invocation.signal.addEventListener(
            'abort',
            () => reject(new Error('retrying')),
            { once: true },
          );
        });
        return `attempt-${attempts}`;
      },
      onControl: (value) => {
        control = value;
      },
    });
    await vi.waitFor(() => expect(attempts).toBe(1));
    control('aaaaaaaaaaaa' as ExecutionId, 'retry');
    await vi.waitFor(() => expect(attempts).toBe(2));
    releases.at(-1)?.();
    const retried = await retryRun;
    expect(retried.snapshot.calls[0]?.attempts).toMatchObject([
      { number: 1, id: 'aaaaaaaaaaaa' },
      { number: 2, id: 'bbbbbbbbbbbb' },
    ]);
    // Logical call start must survive re-queue so duration covers every attempt.
    const firstAttemptStarted =
      retried.snapshot.calls[0]?.attempts[0]?.startedAt;
    expect(firstAttemptStarted).toEqual(expect.any(String));
    expect(retried.snapshot.calls[0]?.timestamps.startedAt).toBe(
      firstAttemptStarted,
    );

    let skipControl!: WorkflowScriptControl;
    let skipStarted = false;
    const skipRun = runWorkflowScript({
      script: `export const meta = {
  name: 'skip',
  description: 'skip observation',
}
return await agent('skip secret', { label: 'Skip task' })`,
      runAgent: async (invocation) => {
        skipStarted = true;
        invocation.report?.({
          childExecutionId: 'cccccccccccc' as ExecutionId,
        });
        return new Promise((_resolve, reject) =>
          invocation.signal.addEventListener('abort', () =>
            reject(new Error('stopped')),
          ),
        );
      },
      onControl: (value) => {
        skipControl = value;
      },
    });
    await vi.waitFor(() => expect(skipStarted).toBe(true));
    skipControl('cccccccccccc' as ExecutionId, 'skip');
    const skipped = await skipRun;
    expect(skipped.result).toBe(WORKFLOW_SKIPPED_RESULT);
    expect(skipped.snapshot.calls[0]?.status).toBe('skipped');

    const failed = await runWorkflowScript({
      script: `export const meta = {
  name: 'continue',
  description: 'failure continue observation',
}
const failed = await agent('fails', { label: 'Failing task' })
const passed = await agent('passes', { label: 'Passing task' })
return [failed, passed]`,
      runAgent: async ({ index }) => {
        if (index === 0) throw new Error('expected failure');
        return 'passed';
      },
    });
    expect(failed.result).toEqual([null, 'passed']);
    expect(failed.snapshot.lifecycle).toBe('completed');
    expect(deriveWorkflowCounts(failed.snapshot.calls)).toMatchObject({
      failed: 1,
      completed: 1,
    });

    const cached = await runWorkflowScript({
      script: `export const meta = {
  name: 'continue',
  description: 'failure continue observation',
}
return await agent('passes', { label: 'Passing task' })`,
      runAgent: async () => 'passed',
    });
    const replay = await runWorkflowScript({
      script: `export const meta = {
  name: 'continue',
  description: 'failure continue observation',
}
return await agent('passes', { label: 'Passing task' })`,
      journal: cached.journal,
      runAgent: async () => {
        throw new Error('must not run');
      },
    });
    expect(replay.snapshot.calls[0]?.status).toBe('cached');
  });

  it('keeps a failed logical call active until its phase can settle and permits later phases while prior calls run', async () => {
    let releaseDraft!: () => void;
    const { snapshots, onSnapshot } = recordingSnapshots();
    const result = await runWorkflowScript({
      script: `export const meta = {
  name: 'parallel-phases',
  description: 'parallel phase observation',
  phases: ['Draft', 'Review'],
}
phase('Draft')
const draft = agent('draft', { id: 'draft-call' })
phase('Review')
const review = await agent('review', { id: 'review-call' })
return [await draft, review]`,
      runAgent: async ({ index }) => {
        if (index === 0) {
          return new Promise<string>((resolve) => {
            releaseDraft = () => resolve('draft');
          });
        }
        releaseDraft();
        return 'review';
      },
      onSnapshot,
    });

    expect(result.result).toEqual(['draft', 'review']);
    expect(result.snapshot.calls.map((call) => call.id)).toEqual([
      'draft-call',
      'review-call',
    ]);
    expect(
      snapshots.some((snapshot) => {
        const draft = snapshot.calls.find((call) => call.id === 'draft-call');
        const review = snapshot.calls.find((call) => call.id === 'review-call');
        return (
          snapshot.currentStageId === 'stage-2' &&
          draft?.status === 'running' &&
          review?.status === 'running' &&
          snapshot.stages[0]?.lifecycle === 'completed'
        );
      }),
    ).toBe(true);

    const { snapshots: failureSnapshots, onSnapshot: failureOnSnapshot } =
      recordingSnapshots();
    const continued = await runWorkflowScript({
      script: `export const meta = {
  name: 'failure-stage',
  description: 'failure stage',
  phases: ['Work'],
}
phase('Work')
const failed = await agent('fails')
const passed = await agent('passes')
return [failed, passed]`,
      runAgent: async ({ index }) => {
        if (index === 0) throw new Error('expected failure');
        return 'passed';
      },
      onSnapshot: failureOnSnapshot,
    });
    expect(continued.result).toEqual([null, 'passed']);
    expect(continued.snapshot.stages[0]?.lifecycle).toBe('failed');
    expect(
      failureSnapshots.some(
        (snapshot) =>
          snapshot.calls[0]?.status === 'failed' &&
          snapshot.stages[0]?.lifecycle === 'active' &&
          snapshot.stages[0]?.completedAt === undefined,
      ),
    ).toBe(true);
  });

  it('marks the active stage failed when orchestration throws with no failed call', async () => {
    const { snapshots, onSnapshot } = recordingSnapshots();
    await expect(
      runWorkflowScript({
        script: `export const meta = {
  name: 'orchestration-fail',
  description: 'stage fails without a failed call',
  phases: ['Merge'],
}
phase('Merge')
const ok = await agent('already done', { id: 'done' })
throw new Error('reduce failed after success')`,
        runAgent: async () => 'done',
        onSnapshot,
      }),
    ).rejects.toThrow(/reduce failed after success/);

    // Script throw after a successful call must not leave Merge as completed
    // just because call-derived settlement saw only completed work.
    const terminal = finalSnapshot(snapshots);
    expect(terminal.lifecycle).toBe('failed');
    expect(terminal.stages[0]?.lifecycle).toBe('failed');
    expect(terminal.calls[0]?.status).toBe('completed');
  });

  it('marks a call-less active stage failed on orchestration throw', async () => {
    const { snapshots, onSnapshot } = recordingSnapshots();
    await expect(
      runWorkflowScript({
        script: `export const meta = {
  name: 'empty-stage-fail',
  description: 'phase with no agent() then throw',
  phases: ['Merge'],
}
phase('Merge')
throw new Error('reduce only')`,
        runAgent: async () => {
          throw new Error('must not run');
        },
        onSnapshot,
      }),
    ).rejects.toThrow(/reduce only/);

    const terminal = finalSnapshot(snapshots);
    expect(terminal.lifecycle).toBe('failed');
    // Without the active-stage override, call-less stages settle as skipped.
    expect(terminal.stages[0]?.lifecycle).toBe('failed');
  });

  it('terminalizes cancellation with no live tasks and balanced counts', async () => {
    const controller = new AbortController();
    const { snapshots, onSnapshot } = recordingSnapshots();
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'cancel',
  description: 'cancel observation',
}
return await agent('cancel secret', { label: 'Cancelled task' })`,
      signal: controller.signal,
      runAgent: async (invocation) =>
        new Promise((_resolve, reject) =>
          invocation.signal.addEventListener('abort', () =>
            reject(new Error('cancelled')),
          ),
        ),
      onSnapshot,
    });
    await vi.waitFor(() =>
      expect(
        snapshots.some(
          (snapshot) => deriveWorkflowCounts(snapshot.calls).running === 1,
        ),
      ).toBe(true),
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });

    const terminal = finalSnapshot(snapshots);
    expect(terminal.lifecycle).toBe('cancelled');
    const terminalCounts = deriveWorkflowCounts(terminal.calls);
    expect(terminalCounts.cancelled).toBe(1);
    expect(
      terminalCounts.running + terminalCounts.starting + terminalCounts.queued,
    ).toBe(0);
    expect(
      terminalCounts.completed +
        terminalCounts.failed +
        terminalCounts.cancelled +
        terminalCounts.skipped +
        terminalCounts.cached,
    ).toBe(terminal.calls.length);
  });
  it('stops after a first snapshot write failure and preserves its cause', async () => {
    const failure = new Error('initial snapshot disk full');
    const runner = vi.fn(async () => 'unused');
    const onSnapshot = vi.fn(async () => {
      throw failure;
    });

    await expect(
      runWorkflowScript({
        script: `export const meta = {
  name: 'initial-persistence-failure',
  description: 'initial persistence failure',
}
return await agent('must not start')`,
        runAgent: runner,
        onSnapshot,
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      cause: failure,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it('suppresses coalesced and later snapshots after an active write fails', async () => {
    const failure = new Error('active snapshot disk full');
    let rejectWrite!: () => void;
    const failedWrite = new Promise<void>((_resolve, reject) => {
      rejectWrite = () => reject(failure);
    });
    let childAborted = false;
    let childAbortReason: unknown;
    const onSnapshot = vi.fn(async () => {
      if (onSnapshot.mock.calls.length === 2) await failedWrite;
    });
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'active-persistence-failure',
  description: 'active persistence failure',
}
return await agent('active work')`,
      runAgent: async (invocation) =>
        new Promise((_resolve, reject) =>
          invocation.signal.addEventListener(
            'abort',
            () => {
              childAborted = true;
              childAbortReason = invocation.signal.reason;
              reject(invocation.signal.reason);
            },
            { once: true },
          ),
        ),
      onSnapshot,
    });

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    rejectWrite();
    const rejection = await run.catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      name: 'WorkflowRunAbortError',
      cause: failure,
    });
    expect(childAborted).toBe(true);
    expect(childAbortReason).toBe(rejection);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('coalesces snapshot transitions while a metadata write is pending', async () => {
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let releaseAgent!: () => void;
    const agentResult = new Promise<string>((resolve) => {
      releaseAgent = () => resolve('done');
    });
    let runnerStarted = false;
    let writes = 0;
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'coalesced-writes',
  description: 'coalesced writes',
}
return await agent('work')`,
      runAgent: async () => {
        runnerStarted = true;
        return agentResult;
      },
      onSnapshot: async () => {
        writes += 1;
        if (writes === 2) await blockedWrite;
      },
    });

    await vi.waitFor(() => expect(runnerStarted).toBe(true));
    releaseWrite();
    releaseAgent();
    await run;

    expect(writes).toBeLessThan(8);
  });

  it('aborts active work when snapshot persistence fails', async () => {
    let runnerStarted = false;
    const run = runWorkflowScript({
      script: `export const meta = {
  name: 'persistence-failure',
  description: 'persistence failure',
}
return await agent('work')`,
      runAgent: async (invocation) => {
        runnerStarted = true;
        return new Promise((_resolve, reject) =>
          invocation.signal.addEventListener(
            'abort',
            () => reject(invocation.signal.reason),
            { once: true },
          ),
        );
      },
      onSnapshot: async (snapshot) => {
        if (deriveWorkflowCounts(snapshot.calls).running > 0) {
          throw new Error('snapshot disk full');
        }
      },
    });

    await expect(run).rejects.toThrow(/snapshot disk full/);
    expect(runnerStarted).toBe(true);
  });
});
