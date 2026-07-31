// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { vi } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { createRunScope } from '@agent/runtime/RunScope';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import type { ExecutionId, StorageKey, StreamTabId } from '@shared/schemas';

/** The zero-priced OpenAI model every runtime fixture bills against. */
export const testModelInfo = {
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

interface TestLaunchContextInit {
  executionId: ExecutionId;
  streamId: StreamTabId;
  /** Session owning the run; defaults to the ambient default session. */
  session?: SessionHandle;
  agent?: string;
  /** Trace the run publishes through; defaults to the silent trace. */
  logger?: AgentLaunchContext['logger'];
}

/**
 * A minimal tool-use `AgentLaunchContext` for driving `runFlowWithLifecycle`
 * without a real model handler or flow.
 */
export function createTestLaunchContext({
  executionId,
  streamId,
  session = defaultSession(),
  agent = 'assistant',
  logger = noopTrace,
}: TestLaunchContextInit): AgentLaunchContext {
  const config = AgentConfigSchema.parse({
    agent,
    model: 'test-model',
    agentCategory: AgentCategory.ToolUse,
  });
  const setting = AgentSettingSchema.parse({
    agentCategory: AgentCategory.ToolUse,
  });
  const storageKey = executionId as StorageKey;

  return {
    config,
    setting,
    prompt: AgentPromptSchema.parse({}),
    runScope: createRunScope({
      streamId,
      executionId,
      agentName: config.agent,
      session,
    }),
    logger,
    parentStage: logger.openStage(`Run: ${config.agent}`),
    storageKey,
    userVarChannels: { input: Object.freeze({}), transient: {} },
    attachedMemoryMisses: [],
    usageMonitor: new UsageMonitor(
      testModelInfo,
      { logger, storageKey, streamId },
      { agentName: config.agent, agentCategory: setting.agentCategory },
    ),
    modelHandler: {
      dispose: vi.fn(),
    } as unknown as AgentLaunchContext['modelHandler'],
    disposeTrace: vi.fn(),
  };
}
