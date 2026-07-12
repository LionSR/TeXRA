// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentReviewRunController,
  type AgentReviewRunToken,
} from '@frontend/review/AgentReviewRunController';

function createRunHarness() {
  const stopAgentStream = vi.fn();
  let currentHandle: AgentRunHandle | undefined;
  const session = {
    executions: {
      getHandle: () => currentHandle,
      stopAgentStream,
    },
  } as unknown as SessionHandle;
  const bind = (
    controller: AgentReviewRunController,
    run: AgentReviewRunToken,
    executionId: string,
  ) => {
    const handle = {
      executionId,
      childStreamId: `review#${executionId}`,
      runtimeHost: {},
    } as AgentRunHandle;
    currentHandle = handle;
    controller.bind(run, handle);
    return handle;
  };
  return { bind, session, stopAgentStream };
}

describe('AgentReviewRunController', () => {
  it('latches a stop requested before the execution handle arrives', () => {
    const controller = new AgentReviewRunController();
    const { bind, session, stopAgentStream } = createRunHarness();
    const run = controller.start(session);

    expect(controller.requestStop()).toBe(true);
    expect(controller.isActive).toBe(true);
    bind(controller, run, 'review-a');

    expect(stopAgentStream).toHaveBeenCalledOnce();
    expect(controller.requestStop()).toBe(false);
    expect(stopAgentStream).toHaveBeenCalledOnce();
    expect(controller.isActive).toBe(true);
    expect(controller.finish(run)).toBe(true);
    expect(controller.isActive).toBe(false);
  });

  it('ignores a stale finalizer and stops only the current run', () => {
    const controller = new AgentReviewRunController();
    const first = createRunHarness();
    const runA = controller.start(first.session);
    first.bind(controller, runA, 'review-a');
    expect(controller.finish(runA)).toBe(true);

    const second = createRunHarness();
    const runB = controller.start(second.session);
    second.bind(controller, runB, 'review-b');

    expect(controller.finish(runA)).toBe(false);
    expect(controller.requestStop()).toBe(true);
    expect(first.stopAgentStream).not.toHaveBeenCalled();
    expect(second.stopAgentStream).toHaveBeenCalledOnce();
  });
});
