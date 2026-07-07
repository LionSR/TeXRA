// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { clearStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import {
  SessionHandle,
  currentSession,
  defaultSession,
} from '@agent/runtime/SessionHandle';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import type { IInterruptible } from '@agent/runtime/InterruptRegistry';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { createRecordingHost } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  writeTerminalStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: storageMocks.writeTerminalStatus,
}));

function initTestPlatform(): Promise<void> {
  return installPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });
}

function createLifecycleContext(
  executionId: ExecutionId,
  streamId: StreamTabId,
  streamStatus: StreamStatusMachine,
  session: SessionHandle,
): AgentLaunchContext {
  const explicit = createRecordingHost();
  const config = AgentConfigSchema.parse({
    agent: 'assistant',
    model: 'test-model',
    agentCategory: AgentCategory.ToolUse,
  });
  const setting = AgentSettingSchema.parse({
    agentCategory: AgentCategory.ToolUse,
  });
  const prompt = AgentPromptSchema.parse({});
  const storageKey = executionId as StorageKey;
  const modelInfo = {
    capabilities: {
      supportsPromptCaching: false,
      supportsAutoPromptCaching: false,
      supportsReasoning: false,
      cacheDiscountFactor: 0,
    },
    config: {
      provider: ModelProvider.OPENAI,
      name: 'test-model',
      fullName: 'Test Model',
      inputPrice: 0,
      openRouterOnly: false,
      requiresResponsesAPI: false,
    },
  };

  return {
    config,
    setting,
    prompt,
    streamId,
    executionId,
    runtimeHost: explicit.host,
    streamStatus,
    logger: noopTrace,
    parentStage: noopTrace.openStage('Run: assistant'),
    storageKey,
    userVarChannels: { input: Object.freeze({}), transient: {} },
    attachedMemoryMisses: [],
    usageMonitor: new UsageMonitor(
      modelInfo,
      {
        logger: noopTrace,
        runtimeHost: explicit.host,
        storageKey,
        streamId,
      },
      { agentName: config.agent, agentCategory: setting.agentCategory },
    ),
    modelHandler: {
      dispose: vi.fn(),
    } as unknown as AgentLaunchContext['modelHandler'],
    disposeTrace: vi.fn(),
    session,
  };
}

describe('session isolation (SDK Step 7d PR 2)', () => {
  it('currentSession() resolves the active run context session, default otherwise', () => {
    const sessionB = new SessionHandle();
    try {
      expect(currentSession()).toBe(defaultSession());
      const ctx = createRunContext({
        runtimeHost: createRecordingHost().host,
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

  it('a flow-style interrupt registration lands in the run session only', () => {
    const sessionB = new SessionHandle();
    const streamId = 'stream:iso-interrupt' as StreamTabId;
    const interruptible: IInterruptible = { interrupt: vi.fn() };
    try {
      withRunContext(
        createRunContext({
          runtimeHost: createRecordingHost().host,
          session: sessionB,
        }),
        () => {
          currentSession().interrupts.register(streamId, interruptible);
        },
      );

      expect(sessionB.interrupts.get(streamId)).toBe(interruptible);
      expect(defaultSession().interrupts.get(streamId)).toBeUndefined();
    } finally {
      sessionB.dispose();
    }
  });

  it('runFlowWithLifecycle tracks the handle in the run session, not the default', async () => {
    await initTestPlatform();
    const executionId = 'e15001' as ExecutionId;
    const streamId = 'stream:iso-track' as StreamTabId;
    const streamStatus = new StreamStatusMachine();
    const sessionB = new SessionHandle();
    const ctx = createLifecycleContext(
      executionId,
      streamId,
      streamStatus,
      sessionB,
    );

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
      clearStreamStatusForTest(streamStatus, streamId);
      sessionB.dispose();
    }
  });
});
