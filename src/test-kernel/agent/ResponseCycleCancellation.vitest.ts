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

// Stub the inner cycle flow to apply the scripted flags, isolating the node's
// outcome classification from the model-invocation pipeline.
vi.mock('@agent/implementations/flows/reflection/ResponseCycleFlow', () => ({
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

import { ResponseCycleNode } from '@agent/implementations/flows/reflection/nodes/ResponseCycleNode';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import type { AgentFileLocation } from '@shared/schemas';
import { reflectionFlowShared, testRunScope } from './progressTestUtils';
import { testModelCell } from './modelCellTestUtils';

const outputLocation: AgentFileLocation = {
  kind: 'workspace',
  absolutePath: '/tmp/output.xml',
  relativePath: 'output.xml',
};

interface NodeOptions {
  signal?: AbortSignal;
  logger?: {
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  clearCompactionRequest?: () => void;
}

function makeNode(options: NodeOptions): ResponseCycleNode {
  return new ResponseCycleNode().setServices({
    getOutputFileLocation: async () => outputLocation,
    runScope: testRunScope('response-cycle', { signal: options.signal }),
    modelCell: testModelCell({
      initializeOutputAndPrefill: async () => [false, []],
      clearCompactionRequest: options.clearCompactionRequest ?? vi.fn(),
    }),
    config: {},
    setting: {},
    logger: options.logger ?? { error: vi.fn(), debug: vi.fn() },
  } as unknown as ReflectionServices);
}

async function runNode(options: NodeOptions = {}) {
  const node = makeNode(options);
  const shared = reflectionFlowShared();
  const prep = await node.prep(shared);
  const result = await node.exec(prep);
  return { node, shared, prep, result };
}

describe('ResponseCycleNode outcome classification', () => {
  beforeEach(() => {
    Object.assign(flowState, {
      shouldStop: false,
      endTurn: false,
      lastError: undefined,
      contextWindowRecoveryAttempted: false,
      contextWindowRecoveryRequestId: undefined,
    });
  });

  // A round that stopped (e.g. a completed response whose terminal reason was
  // not recognized as end-of-turn, or a token/continuation limit carrying real
  // output) must keep its output unless the run was genuinely interrupted — it
  // used to be discarded as `cancelled` via the `shouldStop && !endTurn` proxy.
  it.each([
    {
      name: 'does NOT cancel a stop-without-end-of-turn when the run is not interrupted',
      interrupted: false,
      expected: 'completed',
    },
    {
      name: 'cancels only when the run is genuinely interrupted',
      interrupted: true,
      expected: 'cancelled',
    },
  ])('$name', async ({ interrupted, expected }) => {
    flowState.shouldStop = true;
    flowState.endTurn = false;

    const { result } = await runNode({
      signal: interrupted ? AbortSignal.abort() : undefined,
    });

    expect(result.outcome).toBe(expected);
  });

  it('keeps a cleanly completed round even if an interrupt races in at completion', async () => {
    flowState.shouldStop = true;
    flowState.endTurn = true;

    const { result } = await runNode({ signal: AbortSignal.abort() });

    expect(result).toMatchObject({
      outcome: 'completed',
      endTurn: true,
    });
  });

  it('keeps the response cursor resumable when interruption cancels the cycle', async () => {
    flowState.shouldStop = true;
    const { node, shared, prep, result } = await runNode({
      signal: AbortSignal.abort(),
    });

    await expect(node.post(shared, prep, result)).resolves.toBe(
      FlowTransition.WAITING,
    );
    expect(shared).toMatchObject({
      continueRounds: false,
      lastError: undefined,
    });
  });

  it.each([
    {
      name: 'clears forced compaction when interruption abandons recovery',
      interrupted: true,
      lastError: undefined,
      expected: 'cancelled',
    },
    {
      name: 'clears forced compaction after invocation retries are exhausted',
      interrupted: false,
      lastError: {
        message: 'HTTP 503 Service Unavailable',
        userRetryable: true,
      },
      expected: 'failed',
    },
  ])('$name', async ({ interrupted, lastError, expected }) => {
    flowState.shouldStop = true;
    flowState.contextWindowRecoveryAttempted = true;
    flowState.contextWindowRecoveryRequestId = 7;
    flowState.lastError = lastError;
    const clearCompactionRequest = vi.fn();

    const { result } = await runNode({
      signal: interrupted ? AbortSignal.abort() : undefined,
      clearCompactionRequest,
    });

    expect(result.outcome).toBe(expected);
    expect(clearCompactionRequest).toHaveBeenCalledWith(7);
  });

  it.each([
    { message: 'HTTP 503 Service Unavailable', userRetryable: true },
    { message: 'Model response was empty', userRetryable: false },
  ])('does not re-log an inner model failure: $message', async (lastError) => {
    flowState.shouldStop = true;
    flowState.lastError = lastError;
    const logger = { error: vi.fn(), debug: vi.fn() };
    const { node, shared, prep, result } = await runNode({ logger });

    await node.post(shared, prep, result);

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(shared.lastError).toBe(lastError);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an outer cycle exception where it becomes structured state', async () => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const node = makeNode({ logger });
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
