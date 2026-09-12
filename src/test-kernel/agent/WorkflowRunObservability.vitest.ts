import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

import type { WorkflowScriptControl } from '@agent/workflowScript/types';
import { runWorkflowScript } from '@agent/workflowScript/runWorkflowScript';
import { WORKFLOW_SKIPPED_RESULT } from '@agent/workflowScript/types';
import {
  WorkflowRunSnapshotSchema,
  deriveWorkflowCounts,
  type RunId,
  type WorkflowRunSnapshot,
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

function finalSnapshot(snapshots: readonly WorkflowRunSnapshot[]) {
  return snapshots.at(-1)!;
}

function recordingSnapshots(): {
  snapshots: WorkflowRunSnapshot[];
  onSnapshot: (snapshot: WorkflowRunSnapshot) => Effect.Effect<void>;
} {
  const snapshots: WorkflowRunSnapshot[] = [];
  return {
    snapshots,
    onSnapshot: (snapshot) =>
      Effect.sync(() => {
        snapshots.push(snapshot);
      }),
  };
}

describe('workflow run observability', () => {
  it.effect(
    'keeps later tasks declared, advances stages monotonically, and skips unreached work',
    () =>
      Effect.gen(function* () {
        const { snapshots, onSnapshot } = recordingSnapshots();
        const result = yield* runWorkflowScript({
          script: `${META}phase('Draft')
await agent('draft privately', { id: 'draft' })
return 'done'`,
          runAgent: () => Effect.succeed('done'),
          onSnapshot,
        });

        // Stage gating: the later-phase call is declared in some snapshot, and
        // wherever it is declared its own stage is still unreached (waiting, or
        // skipped by the settle sweep), never a stage the run has entered.
        const declaredReviewStages = snapshots.flatMap((snapshot) => {
          const review = snapshot.calls.find((call) => call.id === 'review');
          if (review?.status !== 'declared') return [];
          const stage = snapshot.stages.find(
            (entry) => entry.id === review.stageId,
          );
          return [stage?.lifecycle ?? 'unstaged'];
        });
        expect(declaredReviewStages.length).toBeGreaterThan(0);
        expect(
          declaredReviewStages.filter(
            (lifecycle) => lifecycle !== 'waiting' && lifecycle !== 'skipped',
          ),
        ).toEqual([]);
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
          WorkflowRunSnapshotSchema.parse(result.snapshot),
        ).not.toThrow();
        const openTerminalAttempt = structuredClone(result.snapshot);
        openTerminalAttempt.calls[0]!.attempts[0]!.completedAt = undefined;
        expect(
          WorkflowRunSnapshotSchema.safeParse(openTerminalAttempt).success,
        ).toBe(false);

        const { snapshots: failedSnapshots, onSnapshot: failedOnSnapshot } =
          recordingSnapshots();
        const error = yield* Effect.flip(
          runWorkflowScript({
            script: `${META}phase('Review')
phase('Draft')
return null`,
            runAgent: () => Effect.succeed('unused'),
            onSnapshot: failedOnSnapshot,
          }),
        );
        expect(error.message).toMatch(/monotonically/);
        expect(finalSnapshot(failedSnapshots).lifecycle).toBe('failed');
      }),
  );

  it.effect(
    'rejects empty structural identities, titles, and stage references',
    () =>
      Effect.gen(function* () {
        const { snapshots, onSnapshot } = recordingSnapshots();
        const result = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'structural-fields',
  description: 'structural field validation',
  phases: ['Work'],
}
phase('Work')
return await agent('work', { id: 'work-call' })`,
          runAgent: (invocation) =>
            Effect.sync(() => {
              invocation.report({ childRunId: 'aaaaaaaaaaaa' as RunId });
              return 'done';
            }),
          onSnapshot,
        });

        const expectEmptyFieldRejected = (
          mutate: (snapshot: WorkflowRunSnapshot) => void,
        ): void => {
          const candidate = structuredClone(result.snapshot);
          mutate(candidate);
          expect(WorkflowRunSnapshotSchema.safeParse(candidate).success).toBe(
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
          candidate.calls[0]!.attempts[0]!.id = '' as RunId;
        });

        // A meta.json persisted by an older build with a retired key fails
        // loudly: there is no compatibility reader, by policy.
        const legacy = structuredClone(result.snapshot) as unknown as {
          calls: Array<Record<string, unknown>>;
        };
        legacy.calls[0]!.stageTitle = 'Work';
        expect(WorkflowRunSnapshotSchema.safeParse(legacy).success).toBe(false);

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
        expect(WorkflowRunSnapshotSchema.safeParse(active).success).toBe(false);
      }),
  );

  it.effect(
    'records queued work before admission and starts attempts only inside the queue slot',
    () =>
      Effect.gen(function* () {
        const firstRun = yield* Deferred.make<void>();
        const queuedObserved = yield* Deferred.make<void>();
        const runner = vi.fn((invocation) =>
          Effect.gen(function* () {
            if (invocation.index === 0) yield* Deferred.await(firstRun);
            return 'done';
          }),
        );
        const snapshots: WorkflowRunSnapshot[] = [];
        const onSnapshot = (snapshot: WorkflowRunSnapshot) =>
          Effect.sync(() => {
            snapshots.push(snapshot);
            if (
              snapshot.calls[0]?.status === 'running' &&
              snapshot.calls[1]?.status === 'queued' &&
              snapshot.calls[1]?.attempts.length === 0
            ) {
              Deferred.doneUnsafe(queuedObserved, Effect.void);
            }
          });
        const run = yield* runWorkflowScript({
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
        }).pipe(Effect.forkChild);

        yield* Deferred.await(queuedObserved);
        expect(runner).toHaveBeenCalledTimes(1);
        yield* Deferred.succeed(firstRun, undefined);
        const result = yield* Fiber.join(run);
        expect(deriveWorkflowCounts(result.snapshot.calls).completed).toBe(2);
        expect(
          result.snapshot.calls.every((call) => call.attempts.length === 1),
        ).toBe(true);
      }),
  );

  it.effect(
    'tracks retry attempts, interactive skip, cached replay, and failure-continue',
    () =>
      Effect.gen(function* () {
        let control!: WorkflowScriptControl;
        let attempts = 0;
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<string>();
        const retryRun = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'retry',
  description: 'retry observation',
}
return await agent('retry secret', { label: 'Retry task' })`,
          runAgent: (invocation) =>
            Effect.gen(function* () {
              attempts += 1;
              invocation.report({
                childRunId: (attempts === 1
                  ? 'aaaaaaaaaaaa'
                  : 'bbbbbbbbbbbb') as RunId,
              });
              if (attempts === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                return yield* Effect.never;
              }
              yield* Deferred.succeed(secondStarted, undefined);
              return yield* Deferred.await(secondRelease);
            }),
          onControl: (value) => {
            control = value;
          },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        control('aaaaaaaaaaaa' as RunId, 'retry');
        yield* Deferred.await(secondStarted);
        yield* Deferred.succeed(secondRelease, 'attempt-2');
        const retried = yield* Fiber.join(retryRun);
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
        const skipStarted = yield* Deferred.make<void>();
        const skipRun = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'skip',
  description: 'skip observation',
}
return await agent('skip secret', { label: 'Skip task' })`,
          runAgent: (invocation) =>
            Effect.gen(function* () {
              invocation.report({
                childRunId: 'cccccccccccc' as RunId,
              });
              yield* Deferred.succeed(skipStarted, undefined);
              return yield* Effect.never;
            }),
          onControl: (value) => {
            skipControl = value;
          },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(skipStarted);
        skipControl('cccccccccccc' as RunId, 'skip');
        const skipped = yield* Fiber.join(skipRun);
        expect(skipped.result).toBe(WORKFLOW_SKIPPED_RESULT);
        expect(skipped.snapshot.calls[0]?.status).toBe('skipped');

        const failed = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'continue',
  description: 'failure continue observation',
}
const failed = await agent('fails', { label: 'Failing task' })
const passed = await agent('passes', { label: 'Passing task' })
return [failed, passed]`,
          runAgent: ({ index }) =>
            index === 0
              ? Effect.fail(new Error('expected failure'))
              : Effect.succeed('passed'),
        });
        expect(failed.result).toEqual([null, 'passed']);
        expect(failed.snapshot.lifecycle).toBe('completed');
        expect(deriveWorkflowCounts(failed.snapshot.calls)).toMatchObject({
          failed: 1,
          completed: 1,
        });

        const cached = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'continue',
  description: 'failure continue observation',
}
return await agent('passes', { label: 'Passing task' })`,
          runAgent: () => Effect.succeed('passed'),
        });
        const replay = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'continue',
  description: 'failure continue observation',
}
return await agent('passes', { label: 'Passing task' })`,
          journal: cached.journal,
          runAgent: () => Effect.fail(new Error('must not run')),
        });
        expect(replay.snapshot.calls[0]?.status).toBe('cached');
      }),
  );

  it.effect(
    'keeps a failed logical call active until its phase can settle and permits later phases while prior calls run',
    () =>
      Effect.gen(function* () {
        const releaseDraft = yield* Deferred.make<string>();
        const { snapshots, onSnapshot } = recordingSnapshots();
        const result = yield* runWorkflowScript({
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
          runAgent: ({ index }) =>
            index === 0
              ? Deferred.await(releaseDraft)
              : Deferred.succeed(releaseDraft, 'draft').pipe(
                  Effect.as('review'),
                ),
          onSnapshot,
        });

        expect(result.result).toEqual(['draft', 'review']);
        expect(result.snapshot.calls.map((call) => call.id)).toEqual([
          'draft-call',
          'review-call',
        ]);
        expect(
          snapshots.some((snapshot) => {
            const draft = snapshot.calls.find(
              (call) => call.id === 'draft-call',
            );
            const review = snapshot.calls.find(
              (call) => call.id === 'review-call',
            );
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
        const continued = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'failure-stage',
  description: 'failure stage',
  phases: ['Work'],
}
phase('Work')
const failed = await agent('fails')
const passed = await agent('passes')
return [failed, passed]`,
          runAgent: ({ index }) =>
            index === 0
              ? Effect.fail(new Error('expected failure'))
              : Effect.succeed('passed'),
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
      }),
  );

  it.effect(
    'marks the active stage failed when orchestration throws with no failed call',
    () =>
      Effect.gen(function* () {
        const { snapshots, onSnapshot } = recordingSnapshots();
        const error = yield* Effect.flip(
          runWorkflowScript({
            script: `export const meta = {
  name: 'orchestration-fail',
  description: 'stage fails without a failed call',
  phases: ['Merge'],
}
phase('Merge')
const ok = await agent('already done', { id: 'done' })
throw new Error('reduce failed after success')`,
            runAgent: () => Effect.succeed('done'),
            onSnapshot,
          }),
        );
        expect(error.message).toMatch(/reduce failed after success/);

        // Script throw after a successful call must not leave Merge as completed
        // just because call-derived settlement saw only completed work.
        const terminal = finalSnapshot(snapshots);
        expect(terminal.lifecycle).toBe('failed');
        expect(terminal.stages[0]?.lifecycle).toBe('failed');
        expect(terminal.calls[0]?.status).toBe('completed');
      }),
  );

  it.effect(
    'marks a call-less active stage failed on orchestration throw',
    () =>
      Effect.gen(function* () {
        const { snapshots, onSnapshot } = recordingSnapshots();
        const error = yield* Effect.flip(
          runWorkflowScript({
            script: `export const meta = {
  name: 'empty-stage-fail',
  description: 'phase with no agent() then throw',
  phases: ['Merge'],
}
phase('Merge')
throw new Error('reduce only')`,
            runAgent: () => Effect.fail(new Error('must not run')),
            onSnapshot,
          }),
        );
        expect(error.message).toMatch(/reduce only/);

        const terminal = finalSnapshot(snapshots);
        expect(terminal.lifecycle).toBe('failed');
        // Without the active-stage override, call-less stages settle as skipped.
        expect(terminal.stages[0]?.lifecycle).toBe('failed');
      }),
  );

  it.effect(
    'terminalizes cancellation with no live tasks and balanced counts',
    () =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const snapshots: WorkflowRunSnapshot[] = [];
        const runningObserved = yield* Deferred.make<void>();
        const onSnapshot = (snapshot: WorkflowRunSnapshot) =>
          Effect.sync(() => {
            snapshots.push(snapshot);
            if (deriveWorkflowCounts(snapshot.calls).running === 1) {
              Deferred.doneUnsafe(runningObserved, Effect.void);
            }
          });
        const run = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'cancel',
  description: 'cancel observation',
}
return await agent('cancel secret', { label: 'Cancelled task' })`,
          signal: controller.signal,
          runAgent: () => Effect.never,
          onSnapshot,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(runningObserved);
        controller.abort(new DOMException('cancelled', 'AbortError'));
        const cancellation = yield* Fiber.join(run).pipe(Effect.flip);
        expect(cancellation).toMatchObject({ name: 'AbortError' });

        const terminal = finalSnapshot(snapshots);
        expect(terminal.lifecycle).toBe('cancelled');
        expect(terminal.error).toBe('cancelled');
        expect(terminal.calls[0]?.error).toBeUndefined();
        expect(
          JSON.parse(JSON.stringify(terminal)).calls[0],
        ).not.toHaveProperty('error');
        const terminalCounts = deriveWorkflowCounts(terminal.calls);
        expect(terminalCounts.cancelled).toBe(1);
        expect(terminalCounts.running + terminalCounts.queued).toBe(0);
        expect(
          terminalCounts.completed +
            terminalCounts.failed +
            terminalCounts.cancelled +
            terminalCounts.skipped +
            terminalCounts.cached,
        ).toBe(terminal.calls.length);
      }),
  );
  it.effect(
    'stops after a first snapshot write failure and preserves its cause',
    () =>
      Effect.gen(function* () {
        const failure = new Error('initial snapshot disk full');
        const runner = vi.fn(() => Effect.succeed('unused'));
        const onSnapshot = vi.fn(() => Effect.fail(failure));

        const error = yield* Effect.flip(
          runWorkflowScript({
            script: `export const meta = {
  name: 'initial-persistence-failure',
  description: 'initial persistence failure',
}
return await agent('must not start')`,
            runAgent: runner,
            onSnapshot,
          }),
        );
        expect(error).toMatchObject({
          name: 'WorkflowRunAbortError',
          cause: failure,
        });
        expect(runner).not.toHaveBeenCalled();
        expect(onSnapshot).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'suppresses coalesced and later snapshots after an active write fails',
    () =>
      Effect.gen(function* () {
        const failure = new Error('active snapshot disk full');
        const writeStarted = yield* Deferred.make<void>();
        const childStarted = yield* Deferred.make<void>();
        const failedWrite = yield* Deferred.make<void, Error>();
        let childAborted = false;
        let childAbortReason: unknown;
        const onSnapshot = vi.fn(() =>
          onSnapshot.mock.calls.length === 2
            ? Effect.gen(function* () {
                yield* Deferred.succeed(writeStarted, undefined);
                yield* Deferred.await(failedWrite);
              })
            : Effect.void,
        );
        const run = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'active-persistence-failure',
  description: 'active persistence failure',
}
return await agent('active work')`,
          runAgent: (invocation) =>
            Effect.callback((resume) => {
              invocation.signal.addEventListener(
                'abort',
                () => {
                  childAborted = true;
                  childAbortReason = invocation.signal.reason;
                  resume(Effect.fail(invocation.signal.reason));
                },
                { once: true },
              );
              Deferred.doneUnsafe(childStarted, Effect.void);
            }),
          onSnapshot,
        }).pipe(Effect.forkChild);

        yield* Deferred.await(writeStarted);
        yield* Deferred.await(childStarted);
        yield* Deferred.fail(failedWrite, failure);
        const rejection = yield* Fiber.join(run).pipe(Effect.flip);
        expect(rejection).toMatchObject({
          name: 'WorkflowRunAbortError',
          cause: failure,
        });
        expect(childAborted).toBe(true);
        expect(childAbortReason).toMatchObject({ name: 'AbortError' });
        expect(onSnapshot).toHaveBeenCalledTimes(2);
      }),
  );
});
