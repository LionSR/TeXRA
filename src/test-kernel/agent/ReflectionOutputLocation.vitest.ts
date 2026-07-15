// Third-party imports
import { describe, expect, it } from 'vitest';

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

// Local imports - shared schemas
import type { AgentFileLocation } from '@shared/schemas';

function reflectionShared(): ReflectionFlowShared {
  return {
    currentRound: 1,
    totalRounds: 2,
    workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
    context: {
      messages: [],
      stateRoundSnapshot: ConversationRoundStateSnapshotSchema.parse({
        roundIndex: 1,
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

describe('reflection output location resolution', () => {
  it('awaits async output location resolvers before initializing a round', async () => {
    const outputLocation: AgentFileLocation = {
      kind: 'workspace',
      absolutePath: '/tmp/output.xml',
      relativePath: 'output.xml',
    };
    let resolvedRound: number | undefined;
    const shared = reflectionShared();
    const node = new ResponseCycleNode().setServices({
      getOutputFileLocation: async (round: number) => {
        resolvedRound = round;
        await Promise.resolve();
        return outputLocation;
      },
    } as unknown as ReflectionServices);

    const prep = await node.prep(shared);

    expect(resolvedRound).toBe(1);
    expect(prep.context).toBe(shared.context);
    expect(prep).not.toHaveProperty('shared');
    expect(prep.outputLocation).toBe(outputLocation);
  });
});
