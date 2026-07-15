// Third-party imports
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

// Local imports - response cycle
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
} from '@agent/core/flows/ResponseCycleFlow';
import type { ResponseCycleServices } from '@agent/core/flows/CycleServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { AgentFileLocation } from '@shared/schemas';

const outputLocation: AgentFileLocation = {
  kind: 'workspace',
  absolutePath: '/tmp/output.xml',
  relativePath: 'output.xml',
};

function createShared(
  overrides: Partial<ResponseCycleShared> = {},
): ResponseCycleShared {
  return {
    messages: [],
    shouldStop: false,
    endTurn: false,
    outputExists: true,
    outputLocation,
    ...overrides,
  };
}

function getContinuationNode() {
  const prepNode = createResponseCycleFlow().start;
  const invocationNode = prepNode.getNextNode();
  const processNode = invocationNode?.getNextNode();
  const continuationNode = processNode?.getNextNode();
  if (!continuationNode) {
    throw new Error('Response cycle continuation node is not wired');
  }
  return continuationNode;
}

function createServices(interrupted = false) {
  const round = { continuationCount: 0 };
  const checkInterruption = vi.fn(() => interrupted);
  const checkStopConditions = vi.fn(() => ({
    endTurn: false,
    shouldStop: false,
  }));
  const shouldContinue = vi.fn(() => false);
  const addContinueMessage = vi.fn();
  const services = {
    checkInterruption,
    round,
    run: {},
    setting: {},
    config: {},
    workspace: {},
    logger: { info: vi.fn() },
    modelHandler: {
      checkStopConditions,
      shouldContinue,
      addContinueMessage,
    },
  } as unknown as ResponseCycleServices<unknown>;

  return {
    services,
    round,
    checkInterruption,
    checkStopConditions,
    shouldContinue,
    addContinueMessage,
  };
}

describe('response cycle continuation phases', () => {
  it('requires an output location in cycle-local state', () => {
    expectTypeOf<
      ResponseCycleShared['outputLocation']
    >().toEqualTypeOf<AgentFileLocation>();
  });

  it('skips before interruption checks when no processed response is ready', async () => {
    const shared = createShared();
    const harness = createServices();
    const node = getContinuationNode().setServices(harness.services);

    const prepResult = await node.prep(shared);
    const execResult = await node.exec(prepResult);
    const action = await node.post(shared, prepResult, execResult);

    expect(prepResult).toEqual({ kind: 'skipped' });
    expect(execResult).toEqual({ kind: 'skipped' });
    expect(harness.checkInterruption).not.toHaveBeenCalled();
    expect(shared).toMatchObject({ shouldStop: true, endTurn: false });
    expect(action).toBe(FlowTransition.COMPLETE);
  });

  it('continues token-limited output even when the model declines continuation', async () => {
    const shared = createShared({
      stopReason: 'length',
      processedResponse: 'partial response',
    });
    const harness = createServices();
    const node = getContinuationNode().setServices(harness.services);

    const prepResult = await node.prep(shared);
    const execResult = await node.exec(prepResult);
    const action = await node.post(shared, prepResult, execResult);

    expect(prepResult).toEqual({
      kind: 'success',
      value: {
        interrupted: false,
        stopReason: 'length',
        processedResponse: 'partial response',
      },
    });
    expect(harness.checkStopConditions).toHaveBeenCalledWith(
      'length',
      'partial response',
      harness.round,
      {},
      {},
    );
    expect(harness.shouldContinue).toHaveBeenCalledWith(
      'length',
      'partial response',
      harness.services.setting,
    );
    expect(harness.shouldContinue).toHaveReturnedWith(false);
    expect(harness.round.continuationCount).toBe(1);
    expect(harness.addContinueMessage).toHaveBeenCalledOnce();
    expect(action).toBe(FlowTransition.CONTINUE);
  });

  it('turns a ready response into a completed stop when interrupted', async () => {
    const shared = createShared({
      stopReason: 'stop',
      processedResponse: 'complete response',
    });
    const harness = createServices(true);
    const node = getContinuationNode().setServices(harness.services);

    const prepResult = await node.prep(shared);
    const execResult = await node.exec(prepResult);
    const action = await node.post(shared, prepResult, execResult);

    expect(harness.checkStopConditions).not.toHaveBeenCalled();
    expect(harness.shouldContinue).not.toHaveBeenCalled();
    expect(shared).toMatchObject({ shouldStop: true, endTurn: false });
    expect(harness.addContinueMessage).not.toHaveBeenCalled();
    expect(action).toBe(FlowTransition.COMPLETE);
  });
});
