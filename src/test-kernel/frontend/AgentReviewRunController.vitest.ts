import { it } from '@effect/vitest';
import { Effect } from 'effect';
// Third-party imports
import { describe, expect, vi } from 'vitest';

// Local imports
import type { AgentRunHandle } from '@agent/runtime/RunHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentReviewRunController,
  type AgentReviewRunToken,
} from '@frontend/review/AgentReviewRunController';
import type { RunId } from '@shared/schemas';

function createRunHarness() {
  const stopRequest = vi.fn(() => Effect.succeed({ kind: 'done' }));
  let currentHandle: AgentRunHandle | undefined;
  const session = {
    runs: { getHandle: () => currentHandle },
    requests: { request: stopRequest },
  } as unknown as SessionHandle;
  const bind = (
    controller: AgentReviewRunController,
    run: AgentReviewRunToken,
    runId: RunId,
  ) => {
    const handle = { runId } as AgentRunHandle;
    currentHandle = handle;
    Effect.runSync(controller.bind(run, handle));
    return handle;
  };
  return { bind, session, stopRequest };
}

function startBoundRun(
  controller: AgentReviewRunController,
  harness: ReturnType<typeof createRunHarness>,
  runId: RunId,
): AgentReviewRunToken {
  const run = controller.start(harness.session);
  harness.bind(controller, run, runId);
  return run;
}

function reviewCollection(...changedFiles: string[]) {
  return {
    repoRoot: '/repo',
    changedFiles,
  };
}

function stopReview(controller: AgentReviewRunController): boolean {
  const stop = controller.requestStop();
  Effect.runSync(stop.settlement);
  return stop.accepted;
}

describe('AgentReviewRunController', () => {
  it('latches a stop requested before the run handle arrives', () => {
    const controller = new AgentReviewRunController();
    const harness = createRunHarness();
    const run = controller.start(harness.session);

    expect(stopReview(controller)).toBe(true);
    expect(controller.isActive).toBe(true);
    harness.bind(controller, run, 'review-a' as RunId);

    expect(harness.stopRequest).toHaveBeenCalledOnce();
    expect(stopReview(controller)).toBe(false);
    expect(harness.stopRequest).toHaveBeenCalledOnce();
    expect(controller.isActive).toBe(true);
    expect(controller.finish(run)).toBe(true);
    expect(controller.isActive).toBe(false);
  });

  it('ignores a stale finalizer and stops only the current run', () => {
    const controller = new AgentReviewRunController();
    const first = createRunHarness();
    const runA = startBoundRun(controller, first, 'review-a' as RunId);
    expect(controller.finish(runA)).toBe(true);

    const second = createRunHarness();
    startBoundRun(controller, second, 'review-b' as RunId);

    expect(controller.finish(runA)).toBe(false);
    expect(stopReview(controller)).toBe(true);
    expect(first.stopRequest).not.toHaveBeenCalled();
    expect(second.stopRequest).toHaveBeenCalledOnce();
  });

  it.effect('discards a running review without releasing the slot', () =>
    Effect.gen(function* () {
      const controller = new AgentReviewRunController();
      const harness = createRunHarness();
      const run = startBoundRun(controller, harness, 'review-a' as RunId);
      controller.collect(run, reviewCollection('src/a.ts'));

      yield* controller.discard();

      expect(harness.stopRequest).toHaveBeenCalledOnce();
      // The run settles on its own schedule, so the slot stays claimed
      // while its results and any further reports are dropped.
      expect(controller.isActive).toBe(true);
      expect(controller.isCurrent(run)).toBe(false);
      expect(controller.collection).toBeUndefined();

      controller.collect(run, reviewCollection('src/b.ts'));
      expect(controller.collection).toBeUndefined();

      expect(controller.finish(run)).toBe(true);
      expect(controller.isActive).toBe(false);
    }),
  );

  it.effect(
    'leaves a later run current after an earlier one was discarded',
    () =>
      Effect.gen(function* () {
        const controller = new AgentReviewRunController();
        const first = createRunHarness();
        const runA = startBoundRun(controller, first, 'review-a' as RunId);
        yield* controller.discard();
        expect(controller.finish(runA)).toBe(true);

        const second = createRunHarness();
        const runB = controller.start(second.session);
        expect(controller.isCurrent(runB)).toBe(true);
        expect(controller.isCurrent(runA)).toBe(false);
      }),
  );
});
