// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scripted state the mocked ResponseCycleFlow writes back onto the cycle shared
// object, so each test controls the post-run `shouldStop` / `endTurn` flags.
const flowState = vi.hoisted(() => ({
  shouldStop: false,
  endTurn: false,
  lastError: undefined as
    { message: string; userRetryable: boolean } | undefined,
  contextWindowRecoveryAttempted: false,
  contextWindowRecoveryRequestId: undefined as number | undefined,
}));

// Replace the inner cycle flow with a stub that just applies the scripted flags.
// This isolates ResponseCycleNode's outcome *classification* from the full
// model-invocation pipeline.
vi.mock('@agent/core/flows/ResponseCycleFlow', () => ({
  createResponseCycleFlow: () => ({
    setServices() {},
    async run(shared: {
      shouldStop: boolean;
      endTurn: boolean;
      lastError?: { message: string; userRetryable: boolean };
      contextWindowRecoveryAttempted?: boolean;
      contextWindowRecoveryRequestId?: number;
    }) {
      shared.shouldStop = flowState.shouldStop;
      shared.endTurn = flowState.endTurn;
      shared.lastError = flowState.lastError;
      shared.contextWindowRecoveryAttempted =
        flowState.contextWindowRecoveryAttempted;
      shared.contextWindowRecoveryRequestId =
        flowState.contextWindowRecoveryRequestId;
    },
  }),
}));

// Local imports
import { ResponseCycleNode } from '@agent/implementations/flows/reflection/nodes/ResponseCycleNode';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import type { AgentFileLocation } from '@shared/schemas';
import { reflectionFlowShared } from './progressTestUtils';
import { testModelCell } from './modelCellTestUtils';

const outputLocation: AgentFileLocation = {
  kind: 'workspace',
  absolutePath: '/tmp/output.xml',
  relativePath: 'output.xml',
};

function makeNode(options: {
  checkInterruption: () => boolean;
  logger?: {
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  clearCompactionRequest?: () => void;
}): ResponseCycleNode {
  return new ResponseCycleNode().setServices({
    getOutputFileLocation: async () => outputLocation,
    checkInterruption: options.checkInterruption,
    modelCell: testModelCell({
      initializeOutputAndPrefill: async () => [false, []],
      clearCompactionRequest: options.clearCompactionRequest ?? vi.fn(),
    }),
    config: {},
    setting: {},
    logger: options.logger ?? { error: vi.fn(), debug: vi.fn() },
  } as unknown as ReflectionServices);
}

async function runCycle(checkInterruption: () => boolean) {
  const node = makeNode({ checkInterruption });
  const prep = await node.prep(reflectionFlowShared());
  return node.exec(prep);
}

describe('ResponseCycleNode outcome classification', () => {
  beforeEach(() => {
    flowState.shouldStop = false;
    flowState.endTurn = false;
    flowState.lastError = undefined;
    flowState.contextWindowRecoveryAttempted = false;
    flowState.contextWindowRecoveryRequestId = undefined;
  });

  it('does NOT cancel a stop-without-end-of-turn when the run is not interrupted', async () => {
    // The regression: a round that stopped (e.g. a completed response whose
    // terminal reason was not recognized as end-of-turn, or a token/continuation
    // limit carrying real output) used to be discarded as `cancelled` via the
    // `shouldStop && !endTurn` proxy. It must now complete so its output is kept.
    flowState.shouldStop = true;
    flowState.endTurn = false;

    const result = await runCycle(() => false);

    expect(result.outcome).toBe('completed');
  });

  it('cancels only when the run is genuinely interrupted', async () => {
    flowState.shouldStop = true;
    flowState.endTurn = false;

    const result = await runCycle(() => true);

    expect(result.outcome).toBe('cancelled');
  });

  it('keeps a cleanly completed round even if an interrupt races in at completion', async () => {
    flowState.shouldStop = true;
    flowState.endTurn = true;

    const result = await runCycle(() => true);

    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.endTurn).toBe(true);
    }
  });

  it('clears forced compaction when interruption abandons recovery', async () => {
    flowState.shouldStop = true;
    flowState.contextWindowRecoveryAttempted = true;
    flowState.contextWindowRecoveryRequestId = 7;
    const clearCompactionRequest = vi.fn();

    const node = makeNode({
      checkInterruption: () => true,
      clearCompactionRequest,
    });
    const prep = await node.prep(reflectionFlowShared());

    const result = await node.exec(prep);

    expect(result.outcome).toBe('cancelled');
    expect(clearCompactionRequest).toHaveBeenCalledWith(7);
  });

  it('clears forced compaction after invocation retries are exhausted', async () => {
    flowState.shouldStop = true;
    flowState.contextWindowRecoveryAttempted = true;
    flowState.contextWindowRecoveryRequestId = 7;
    flowState.lastError = {
      message: 'HTTP 503 Service Unavailable',
      userRetryable: true,
    };
    const clearCompactionRequest = vi.fn();
    const node = makeNode({
      checkInterruption: () => false,
      clearCompactionRequest,
    });
    const prep = await node.prep(reflectionFlowShared());

    const result = await node.exec(prep);

    expect(result.outcome).toBe('failed');
    expect(clearCompactionRequest).toHaveBeenCalledWith(7);
  });

  it('propagates an inner model failure without logging it again', async () => {
    flowState.shouldStop = true;
    flowState.lastError = {
      message: 'HTTP 503 Service Unavailable',
      userRetryable: true,
    };
    const logger = { error: vi.fn(), debug: vi.fn() };
    const node = makeNode({ checkInterruption: () => false, logger });
    const shared = reflectionFlowShared();
    const prep = await node.prep(shared);

    const result = await node.exec(prep);
    await node.post(shared, prep, result);

    expect(result).toMatchObject({
      outcome: 'failed',
    });
    expect(shared.lastError).toBe(flowState.lastError);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not infer logging ownership from the error contents', async () => {
    flowState.shouldStop = true;
    flowState.lastError = {
      message: 'Model response was empty',
      userRetryable: false,
    };
    const logger = { error: vi.fn(), debug: vi.fn() };
    const node = makeNode({ checkInterruption: () => false, logger });
    const shared = reflectionFlowShared();
    const prep = await node.prep(shared);

    const result = await node.exec(prep);
    await node.post(shared, prep, result);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an outer cycle exception where it becomes structured state', async () => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const node = makeNode({ checkInterruption: () => false, logger });
    const shared = reflectionFlowShared();
    const prep = await node.prep(shared);

    const result = await node.execFallback(prep, new Error('cycle failed'));
    await node.post(shared, prep, result);

    expect(shared.lastError?.message).toBe('cycle failed');
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Response cycle failed: cycle failed',
    );
  });
});
