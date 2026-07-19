// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Scripted state the mocked ResponseCycleFlow writes back onto the cycle shared
// object, so each test controls the post-run `shouldStop` / `endTurn` flags.
const flowState = vi.hoisted(() => ({ shouldStop: false, endTurn: false }));

// Replace the inner cycle flow with a stub that just applies the scripted flags.
// This isolates ResponseCycleNode's outcome *classification* from the full
// model-invocation pipeline.
vi.mock('@agent/core/flows/ResponseCycleFlow', () => ({
  createResponseCycleFlow: () => ({
    setServices() {},
    async run(shared: { shouldStop: boolean; endTurn: boolean }) {
      shared.shouldStop = flowState.shouldStop;
      shared.endTurn = flowState.endTurn;
    },
  }),
}));

vi.mock('@agent/core/flows/CycleServices', () => ({
  withModelClient: async (services: unknown) => services,
}));

// Local imports - reflection flow
import { ResponseCycleNode } from '@agent/implementations/flows/reflection/nodes/ResponseCycleNode';
import type { ReflectionFlowShared } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';

// Local imports - agent state
import {
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { AgentFileLocation } from '@shared/schemas';

// Local imports - shared schemas

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

function makeNode(checkInterruption: () => boolean): ResponseCycleNode {
  return new ResponseCycleNode().setServices({
    getOutputFileLocation: async () => outputLocation,
    checkInterruption,
    modelHandler: {
      initializeOutputAndPrefill: async () => [false, []],
    },
    config: {},
    setting: {},
  } as unknown as ReflectionServices);
}

async function runCycle(checkInterruption: () => boolean) {
  const node = makeNode(checkInterruption);
  const prep = await node.prep(reflectionShared());
  return node.exec(prep);
}

describe('ResponseCycleNode outcome classification', () => {
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
});
