// Third-party imports
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

// Local imports - response cycle
import type { BaseNode } from '@agent/node';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
} from '@agent/core/flows/ResponseCycleFlow';
import type { ResponseCycleServices } from '@agent/core/flows/CycleServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  ANTHROPIC_STOP,
  type ProviderStopReason,
} from '@agent/types/StopReasonTypes';
import type { AgentFileLocation } from '@shared/schemas';
import { testModelCell } from './modelCellTestUtils';
import { testRunScope } from './progressTestUtils';

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

function getProcessNode() {
  const prepNode = createResponseCycleFlow().start;
  const invocationNode = prepNode.getNextNode();
  const processNode = invocationNode?.getNextNode();
  if (!processNode) {
    throw new Error('Response cycle process node is not wired');
  }
  return processNode;
}

function getContinuationNode() {
  const processNode = getProcessNode();
  const continuationNode = processNode.getNextNode();
  if (!continuationNode) {
    throw new Error('Response cycle continuation node is not wired');
  }
  return continuationNode;
}

async function runNodePhases(
  node: BaseNode,
  shared: ResponseCycleShared,
): Promise<{
  prepResult: unknown;
  execResult: unknown;
  action: string | undefined;
}> {
  const prepResult = await node.prep(shared);
  const execResult = await node.exec(prepResult);
  const action = await node.post(shared, prepResult, execResult);
  return { prepResult, execResult, action };
}

async function runContinuationNode(
  shared: ResponseCycleShared,
  services: ResponseCycleServices<unknown>,
) {
  return runNodePhases(getContinuationNode().setServices(services), shared);
}

/** Services for the process node, which reads only the extracted response. */
function createProcessServices(
  response: { text: string; stopReason: ProviderStopReason },
  overrides: Record<string, unknown> = {},
): ResponseCycleServices<unknown> {
  return {
    round: { responseTimeMs: 0 },
    workspace: AgentWorkspaceState.create(),
    logger: {
      openStage: () => ({ run: (run: () => unknown) => run() }),
      debug: vi.fn(),
      info: vi.fn(),
    },
    modelCell: testModelCell({
      processThinkingBlock: vi.fn(() => null),
      getStreamingConfig: vi.fn(() => false),
      extractResponse: vi.fn(() => ({ ...response, usage: {} })),
      normalizeUsage: vi.fn(() => undefined),
    }),
    ...overrides,
  } as unknown as ResponseCycleServices<unknown>;
}

async function processEmptyResponse(stopReason: ProviderStopReason) {
  const shared = createShared({ responseObject: {} });
  const node = getProcessNode().setServices(
    createProcessServices({ text: '', stopReason }),
  );
  const { action } = await runNodePhases(node, shared);
  return { shared, action };
}

function createServices(interrupted = false, supportsManualCompaction = false) {
  const round = { continuationCount: 0 };
  const checkStopConditions = vi.fn(() => ({
    endTurn: false,
    shouldStop: false,
  }));
  const shouldContinue = vi.fn(() => false);
  const requestCompaction = vi.fn(() => 7);
  const addContinueMessage = vi.fn();
  const services = {
    runScope: testRunScope('response-continuation', {
      signal: interrupted ? AbortSignal.abort() : undefined,
    }),
    round,
    run: {},
    setting: {},
    config: {},
    workspace: {},
    logger: { info: vi.fn(), warn: vi.fn() },
    modelCell: testModelCell({
      supportsManualCompaction,
      checkStopConditions,
      shouldContinue,
      requestCompaction,
      addContinueMessage,
    }),
  } as unknown as ResponseCycleServices<unknown>;

  return {
    services,
    round,
    checkStopConditions,
    shouldContinue,
    requestCompaction,
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

    const { prepResult, execResult, action } = await runContinuationNode(
      shared,
      harness.services,
    );

    expect(prepResult).toEqual({ kind: 'skipped' });
    expect(execResult).toEqual({ kind: 'skipped' });
    expect(shared).toMatchObject({ shouldStop: true, endTurn: false });
    expect(action).toBe(FlowTransition.COMPLETE);
  });

  it('continues token-limited output even when the model declines continuation', async () => {
    const shared = createShared({
      stopReason: 'length',
      processedResponse: 'partial response',
    });
    const harness = createServices();

    const { prepResult, action } = await runContinuationNode(
      shared,
      harness.services,
    );

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

  it('passes an empty Anthropic context-window overflow to continuation', async () => {
    const { shared, action } = await processEmptyResponse(
      ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
    );

    expect(shared).toMatchObject({
      stopReason: ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
      processedResponse: '',
      shouldStop: false,
      endTurn: false,
    });
    expect(action).toBe(FlowTransition.DEFAULT);
  });

  it('retains ordinary empty-response safety', async () => {
    const { shared, action } = await processEmptyResponse(
      ANTHROPIC_STOP.END_TURN,
    );

    expect(shared).toMatchObject({
      processedResponse: undefined,
      shouldStop: true,
      endTurn: false,
    });
    expect(action).toBe(FlowTransition.COMPLETE);
  });

  it('uses the owning session policy to join continued responses', async () => {
    const connectResponseText = vi.fn(async () => '\n');
    const workspace = AgentWorkspaceState.create();
    workspace.assembly.accumulatedOutput = 'left';
    workspace.assembly.lastResponse = 'left';
    const shared = createShared({ responseObject: {} });
    const services = createProcessServices(
      { text: 'right', stopReason: ANTHROPIC_STOP.END_TURN },
      {
        runScope: {
          session: { responseTextProcessing: { connectResponseText } },
        },
        workspace,
      },
    );
    const node = getProcessNode().setServices(services);

    const prepResult = await node.prep(shared);
    const execResult = await node.exec(prepResult);

    expect(connectResponseText).toHaveBeenCalledExactlyOnceWith(
      'left',
      'right',
    );
    expect(execResult).toMatchObject({
      kind: 'success',
      value: {
        bestConnector: '\n',
        updatedAccumulatedOutput: 'left\nright',
      },
    });
  });

  it('forces compaction for an Anthropic overflow with empty assistant text', async () => {
    const shared = createShared({
      stopReason: ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
      processedResponse: '',
    });
    const harness = createServices(false, true);

    const { action } = await runContinuationNode(shared, harness.services);

    expect(harness.requestCompaction).toHaveBeenCalledOnce();
    expect(action).toBe(FlowTransition.CONTINUE);
  });

  it('forces compaction before retrying an Anthropic context-window overflow', async () => {
    const shared = createShared({
      stopReason: ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
      processedResponse: 'partial response',
    });
    const harness = createServices(false, true);

    const { action } = await runContinuationNode(shared, harness.services);

    expect(harness.requestCompaction).toHaveBeenCalledOnce();
    expect(shared.contextWindowRecoveryRequestId).toBe(7);
    expect(harness.round.continuationCount).toBe(1);
    expect(harness.addContinueMessage).toHaveBeenCalledOnce();
    expect(action).toBe(FlowTransition.CONTINUE);
  });

  it.each([
    {
      name: 'stops instead of retrying a context-window overflow without compaction support',
      contextWindowRecoveryAttempted: false,
      supportsManualCompaction: false,
    },
    {
      name: 'stops when forced compaction did not clear the context overflow',
      contextWindowRecoveryAttempted: true,
      supportsManualCompaction: true,
    },
  ])(
    '$name',
    async ({ contextWindowRecoveryAttempted, supportsManualCompaction }) => {
      const shared = createShared({
        stopReason: ANTHROPIC_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED,
        processedResponse: 'partial response',
        contextWindowRecoveryAttempted,
      });
      const harness = createServices(false, supportsManualCompaction);

      const { action } = await runContinuationNode(shared, harness.services);

      expect(harness.requestCompaction).not.toHaveBeenCalled();
      expect(harness.round.continuationCount).toBe(0);
      expect(harness.addContinueMessage).not.toHaveBeenCalled();
      expect(harness.services.logger.warn).toHaveBeenCalledOnce();
      expect(action).toBe(FlowTransition.COMPLETE);
    },
  );

  it('turns a ready response into a completed stop when interrupted', async () => {
    const shared = createShared({
      stopReason: 'stop',
      processedResponse: 'complete response',
    });
    const harness = createServices(true);

    const { action } = await runContinuationNode(shared, harness.services);

    expect(harness.checkStopConditions).not.toHaveBeenCalled();
    expect(harness.shouldContinue).not.toHaveBeenCalled();
    expect(shared).toMatchObject({ shouldStop: true, endTurn: false });
    expect(harness.addContinueMessage).not.toHaveBeenCalled();
    expect(action).toBe(FlowTransition.COMPLETE);
  });
});
