// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scripted state the mocked ResponseCycleFlow writes back onto the cycle shared
// object, so each test controls the post-run `shouldStop` / `endTurn` flags.
const flowState = vi.hoisted(() => ({
  shouldStop: false,
  endTurn: false,
  lastError: undefined as
    { message: string; userRetryable: boolean } | undefined,
  failureLogEmitted: false,
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
      failureLogEmitted?: boolean;
    }) {
      shared.shouldStop = flowState.shouldStop;
      shared.endTurn = flowState.endTurn;
      shared.lastError = flowState.lastError;
      shared.failureLogEmitted = flowState.failureLogEmitted;
    },
  }),
}));

vi.mock('@agent/core/flows/CycleServices', () => ({
  withModelClient: async (services: unknown) => services,
}));

// Local imports
import { ResponseCycleNode } from '@agent/implementations/flows/reflection/nodes/ResponseCycleNode';
import type { ReflectionFlowShared } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import {
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { AgentFileLocation } from '@shared/schemas';

const outputLocation: AgentFileLocation = {
  kind: 'workspace',
  absolutePath: '/tmp/output.xml',
  relativePath: 'output.xml',
};

function reflectionShared(): ReflectionFlowShared {
  return {
    currentRound: 0,
    totalRounds: 2,
    workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
    context: {
      messages: [],
      stateRoundSnapshot: ConversationRoundStateSnapshotSchema.parse({
        roundIndex: 0,
      }),
    },
    outputLocation: null,
    conversation: [],
    runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
    roundStateSnapshots: [],
    roundOutputs: [],
    continueRounds: true,
    endTurn: false,
  };
}

function makeNode(
  checkInterruption: () => boolean,
  logger: {
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  } = {
    error: vi.fn(),
    debug: vi.fn(),
  },
): ResponseCycleNode {
  return new ResponseCycleNode().setServices({
    getOutputFileLocation: async () => outputLocation,
    checkInterruption,
    modelHandler: {
      initializeOutputAndPrefill: async () => [false, []],
    },
    config: {},
    setting: {},
    logger,
  } as unknown as ReflectionServices);
}

async function runCycle(checkInterruption: () => boolean) {
  const node = makeNode(checkInterruption);
  const prep = await node.prep(reflectionShared());
  return node.exec(prep);
}

describe('ResponseCycleNode outcome classification', () => {
  beforeEach(() => {
    flowState.shouldStop = false;
    flowState.endTurn = false;
    flowState.lastError = undefined;
    flowState.failureLogEmitted = false;
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

  it('does not repeat a model failure already logged by RetryState', async () => {
    flowState.shouldStop = true;
    flowState.lastError = {
      message: 'HTTP 503 Service Unavailable',
      userRetryable: true,
    };
    flowState.failureLogEmitted = true;
    const logger = { error: vi.fn(), debug: vi.fn() };
    const node = makeNode(() => false, logger);
    const shared = reflectionShared();
    const prep = await node.prep(shared);

    const result = await node.exec(prep);
    await node.post(shared, prep, result);

    expect(result).toMatchObject({
      outcome: 'failed',
      failureLogEmitted: true,
    });
    expect(shared.lastError).toBe(flowState.lastError);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a model failure not emitted by the inner retry boundary', async () => {
    flowState.shouldStop = true;
    flowState.lastError = {
      message: 'Model response was empty',
      userRetryable: false,
    };
    const logger = { error: vi.fn(), debug: vi.fn() };
    const node = makeNode(() => false, logger);
    const shared = reflectionShared();
    const prep = await node.prep(shared);

    const result = await node.exec(prep);
    await node.post(shared, prep, result);

    expect(logger.error).toHaveBeenCalledWith(
      'Response cycle failed: Model response was empty',
    );
  });
});
