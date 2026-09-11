// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { vi } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { createRunScope } from '@agent/runtime/RunScope';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { AgentCategory, type RunId } from '@shared/schemas';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';

import { testModelCell } from '../modelCellTestUtils';

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
  runId: RunId;
  /** Session owning the run; defaults to the ambient default session. */
  session?: SessionHandle;
  agent?: string;
  /** Run category; defaults to tool-use. */
  category?: AgentCategory;
  /** Trace the run publishes through; defaults to the silent trace. */
  logger?: AgentLaunchContext['logger'];
}

/**
 * A minimal tool-use `AgentLaunchContext` for driving `runFlowWithLifecycle`
 * without a real model handler or flow.
 */
export function createTestLaunchContext({
  runId,
  session = defaultSession(),
  agent = 'assistant',
  category = AgentCategory.ToolUse,
  logger = noopTrace,
}: TestLaunchContextInit): AgentLaunchContext {
  const abortController = new AbortController();
  const config = AgentConfigSchema.parse({
    agent,
    model: 'test-model',
    agentCategory: category,
  });
  const setting = AgentSettingSchema.parse({ agentCategory: category });
  const modelCell = testModelCell(
    { ...testModelInfo, dispose: vi.fn() },
    config.model,
  );

  return {
    config,
    setting,
    prompt: AgentPromptSchema.parse({}),
    // The launch stores a real run carries; no fixture reads through them.
    stores: { secrets: new FakeSecrets(), globalState: new FakeStateStore() },
    runScope: createRunScope({
      runId,
      session,
      signal: abortController.signal,
    }),
    logger,
    parentStage: logger.openStage(`Run: ${config.agent}`),
    userVarChannels: {},
    toolPolicy: createToolPolicy(),
    attachedMemoryMisses: [],
    usageMonitor: new UsageMonitor(
      modelCell,
      { logger, runId, runStageId: undefined },
      { agentName: config.agent, agentCategory: setting.agentCategory },
    ),
    modelCell,
    interrupt: () => abortController.abort(),
    disposeTrace: vi.fn(),
  };
}
