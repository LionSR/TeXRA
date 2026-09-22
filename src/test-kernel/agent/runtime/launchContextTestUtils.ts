// Third-party imports
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { AgentCategory, type RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { fakeStores } from '@test/support/FakePlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';

/**
 * The zero-priced OpenAI model every runtime fixture bills against, shaped
 * as the binding `UsageMonitor.recordUsage` reads.
 */
export const testModelInfo = {
  config: {
    provider: ModelProvider.OPENAI,
    name: 'test-model',
    fullName: 'Test Model',
    inputPrice: 0,
    openRouterOnly: false,
    requiresResponsesAPI: false,
    capabilities: {
      supportsPromptCaching: false,
      supportsAutoPromptCaching: false,
      supportsReasoning: false,
      cacheDiscountFactor: 0,
    },
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
  session = testDefaultSession(),
  agent = 'assistant',
  category = AgentCategory.ToolUse,
  logger = noopTrace,
}: TestLaunchContextInit): AgentLaunchContext {
  const config = AgentConfigSchema.parse({
    agent,
    model: 'test-model',
    agentCategory: category,
  });
  const setting = AgentSettingSchema.parse({ agentCategory: category });

  return {
    config,
    setting,
    prompt: AgentPromptSchema.parse({}),
    ownApiKeyFallback: false,
    // The launch stores a real run carries; no fixture reads through them.
    stores: fakeStores(),
    runId,
    session,
    logger,
    parentStage: logger.openStage(`Run: ${config.agent}`),
    userVarChannels: {},
    initialUserMessageForTranscript: undefined,
    toolPolicy: {},
    attachedMemoryMisses: [],
    usageMonitor: new UsageMonitor(
      {
        logger,
        runId,
        runStageId: undefined,
        config: testWorkspaceRoots().config,
        usageLog: { log: () => {} },
      },
      { agentName: config.agent, agentCategory: setting.agentCategory },
    ),
    modelConfig: buildTestModelConfig(),
    modelCompatibilityKey: null,
  };
}
