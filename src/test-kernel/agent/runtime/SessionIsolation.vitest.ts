import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { currentSession, defaultSession } from '@agent/runtime/SessionHandle';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { clearStreamStatusForTest } from '@test/support/streamStatusTestUtils';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn().mockResolvedValue({
    status: 'durable',
    terminalStatusPersisted: true,
    flowRecord: 'deleted',
  }),
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: storageMocks.finalizeExecution,
}));

describe('session isolation', () => {
  it('currentSession() resolves the active run context session, default otherwise', () => {
    const sessionB = createTestSession();
    try {
      expect(currentSession()).toBe(defaultSession());
      const ctx = createRunContext({
        session: sessionB,
      });
      withRunContext(ctx, () => {
        expect(currentSession()).toBe(sessionB);
      });
      // Resolution falls back to the default session outside any run.
      expect(currentSession()).toBe(defaultSession());
    } finally {
      sessionB.dispose();
    }
  });

  it('a handle interrupt target lands in the run session only', () => {
    const sessionB = createTestSession();
    const executionId = 'exec:iso-interrupt' as ExecutionId;
    const streamId = 'stream:iso-interrupt' as StreamTabId;
    const interrupt = vi.fn();
    try {
      const handle = testExecutionHandle({
        executionId,
        parentStreamId: streamId,
        agent: 'assistant',
      });
      handle.attachInterruptHandler({ interrupt });
      sessionB.executions.track(handle);

      expect(sessionB.executions.kill(executionId)).toBe(true);
      expect(interrupt).toHaveBeenCalledOnce();
      expect(
        defaultSession().executions.getHandle(executionId),
      ).toBeUndefined();
    } finally {
      sessionB.dispose();
    }
  });

  it('runFlowWithLifecycle tracks the handle in the run session, not the default', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
    });
    const executionId = 'e15001' as ExecutionId;
    const streamId = 'stream:iso-track' as StreamTabId;
    const sessionB = createTestSession();
    const ctx = createTestLaunchContext({
      executionId,
      streamId,
      session: sessionB,
    });

    try {
      await runFlowWithLifecycle(ctx, async () => {
        // Mid-run: the handle is registered in session B's registry only.
        expect(sessionB.executions.getHandle(executionId)).toBeDefined();
        expect(
          defaultSession().executions.getHandle(executionId),
        ).toBeUndefined();
        return {
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        };
      });

      // After completion the run session untracked it; default never saw it.
      expect(sessionB.executions.getHandle(executionId)).toBeUndefined();
      expect(
        defaultSession().executions.getHandle(executionId),
      ).toBeUndefined();
    } finally {
      clearStreamStatusForTest(sessionB.status, streamId);
      sessionB.dispose();
    }
  });
});
