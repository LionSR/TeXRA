// Third-party imports
import { expect, it } from 'vitest';

// Local imports
import { ResponseCycleNode } from '@agent/implementations/flows/reflection/nodes/ResponseCycleNode';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import type { AgentFileLocation } from '@shared/schemas';
import { reflectionFlowShared } from './progressTestUtils';

it('awaits async output location resolvers before initializing a round', async () => {
  const outputLocation: AgentFileLocation = {
    kind: 'workspace',
    absolutePath: '/tmp/output.xml',
    relativePath: 'output.xml',
  };
  let resolvedRound: number | undefined;
  const shared = reflectionFlowShared({ currentRound: 1 });
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
