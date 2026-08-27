import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it } from 'vitest';

import { getExecutionStore, registerExecution } from '@agent/storage';
import { AgentToolUseSettingSchema } from '@agent/core/definition/AgentDataclass';
import { flowKey } from '@agent/node/persistedFlow';
import { runToolUseFlow } from '@agent/implementations/flows/tooluse/runToolUseFlow';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

setupPlatform({ workspacePath: '/workspace' });

type LifecycleCase = {
  executionId: ExecutionId;
  streamId: StreamTabId;
};

let counter = 0;
const activeLeases: ExecutionId[] = [];

async function registerCase(name: string): Promise<LifecycleCase> {
  const executionId = `durable-lifecycle-${name}-${counter++}` as ExecutionId;
  const streamId = `durable-lifecycle-stream-${name}-${counter}` as StreamTabId;
  const ctx = createTestLaunchContext({ executionId, streamId });
  await registerExecution(executionId, ctx.config, ctx.config.agent, {
    streamId,
    identity: { kind: 'agent', agent: ctx.config.agent },
  });
  activeLeases.push(executionId);
  return { executionId, streamId };
}

afterEach(async () => {
  for (const executionId of activeLeases.splice(0)) {
    await releaseOwnedExecutionLease(executionId);
  }
});

describe('runFlowWithLifecycle durable startup aborts', () => {
  it('persists CANCELLED and preserves a reused stream checkpoint', async () => {
    const { executionId, streamId } = await registerCase('reused');
    const session = defaultSession();
    const ctx = createTestLaunchContext({ executionId, streamId, session });
    const flowRecord = {
      shared: { messages: [] },
      cursor: { nextNodeId: 'start' },
    };
    const store = getExecutionStore(executionId);
    await store.write(flowKey(executionId), flowRecord);
    seedStreamStatusForTest(session.status, streamId, {
      phase: STREAM_PHASE.COMPLETED,
    });
    let disposition: 'preserve' | 'delete' | undefined;

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async (_handle, lifecycle) => {
          const flowResult = await runToolUseFlow(
            {
              ...ctx,
              setting: AgentToolUseSettingSchema.parse({}),
              onRoundFinalized: () => {},
              onModelChanged: () => {},
              onFlowRecordDisposition: (value) => {
                disposition = value;
                lifecycle.setFlowRecordDisposition(value);
              },
            },
            undefined,
            {
              attach: () => {
                expect(session.executions.kill(executionId)).toBe(true);
              },
              detach: () => {},
            },
          );
          return {
            ...flowResult,
            category: 'toolUse',
            executionId,
            streamId,
          };
        },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(disposition).toBe('preserve');
      await expect(store.readMeta()).resolves.toMatchObject({
        outcome: RUN_OUTCOME.CANCELLED,
      });
      await expect(store.read(flowKey(executionId))).resolves.toEqual(
        flowRecord,
      );
    } finally {
      clearStreamStatusForTest(session.status, streamId);
    }
  });
});
