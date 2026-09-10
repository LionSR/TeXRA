import { Effect } from 'effect';
// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentRunHandle } from '@agent/runtime/RunHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentReviewRunController,
  type AgentReviewRunToken,
} from '@frontend/review/AgentReviewRunController';

function createRunHarness() {
  const stopAgentRun = vi.fn(() => Effect.void);
  let currentHandle: AgentRunHandle | undefined;
  const session = {
    executions: {
      getHandle: () => currentHandle,
      stopAgentRun,
    },
  } as unknown as SessionHandle;
  const bind = (
    controller: AgentReviewRunController,
    run: AgentReviewRunToken,
    runId: string,
  ) => {
    const handle = {
      runId,
      childRunId: `review#${runId}`,
    } as AgentRunHandle;
    currentHandle = handle;
    Effect.runSync(controller.bind(run, handle));
    return handle;
  };
  return { bind, session, stopAgentRun };
}

function startBoundRun(
  controller: AgentReviewRunController,
  harness: ReturnType<typeof createRunHarness>,
  runId: string,
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
    harness.bind(controller, run, 'review-a');

    expect(harness.stopAgentRun).toHaveBeenCalledOnce();
    expect(stopReview(controller)).toBe(false);
    expect(harness.stopAgentRun).toHaveBeenCalledOnce();
    expect(controller.isActive).toBe(true);
    expect(controller.finish(run)).toBe(true);
    expect(controller.isActive).toBe(false);
  });

  it('ignores a stale finalizer and stops only the current run', () => {
    const controller = new AgentReviewRunController();
    const first = createRunHarness();
    const runA = startBoundRun(controller, first, 'review-a');
    expect(controller.finish(runA)).toBe(true);

    const second = createRunHarness();
    startBoundRun(controller, second, 'review-b');

    expect(controller.finish(runA)).toBe(false);
    expect(stopReview(controller)).toBe(true);
    expect(first.stopAgentRun).not.toHaveBeenCalled();
    expect(second.stopAgentRun).toHaveBeenCalledOnce();
  });

  it('carries the collection only while the run is current', () => {
    const controller = new AgentReviewRunController();
    const { session } = createRunHarness();
    const run = controller.start(session);
    const collection = reviewCollection('src/a.ts');

    expect(controller.collection).toBeUndefined();
    controller.collect(run, collection);
    expect(controller.isCurrent(run)).toBe(true);
    expect(controller.collection).toBe(collection);

    expect(controller.finish(run)).toBe(true);
    expect(controller.isCurrent(run)).toBe(false);
    expect(controller.collection).toBeUndefined();
  });

  it('discards a running review without releasing the slot', () => {
    const controller = new AgentReviewRunController();
    const harness = createRunHarness();
    const run = startBoundRun(controller, harness, 'review-a');
    controller.collect(run, reviewCollection('src/a.ts'));

    Effect.runSync(controller.discard());

    expect(harness.stopAgentRun).toHaveBeenCalledOnce();
    // The run settles on its own schedule, so the slot stays claimed
    // while its results and any further reports are dropped.
    expect(controller.isActive).toBe(true);
    expect(controller.isCurrent(run)).toBe(false);
    expect(controller.collection).toBeUndefined();

    controller.collect(run, reviewCollection('src/b.ts'));
    expect(controller.collection).toBeUndefined();

    expect(controller.finish(run)).toBe(true);
    expect(controller.isActive).toBe(false);
  });

  it('leaves a later run current after an earlier one was discarded', () => {
    const controller = new AgentReviewRunController();
    const first = createRunHarness();
    const runA = startBoundRun(controller, first, 'review-a');
    Effect.runSync(controller.discard());
    expect(controller.finish(runA)).toBe(true);

    const second = createRunHarness();
    const runB = controller.start(second.session);
    expect(controller.isCurrent(runB)).toBe(true);
    expect(controller.isCurrent(runA)).toBe(false);
  });
});
