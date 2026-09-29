// Third-party imports

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { AgentCategory, type RunId } from '@shared/schemas';
import { noopTrace } from '@test/support/noopTrace';
import { fakeStores } from '@test/support/FakePlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';

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
 * A minimal tool-use `AgentLaunchContext` for driving `runWithLifecycle`
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
    opening: {
      inputs: {},
      activated: [],
      attachedMemoryMisses: [],
    },
    initialUserMessageForTranscript: undefined,
    toolPolicy: {},
    attachedMemoryMisses: [],
    modelConfig: buildTestModelConfig(),
  };
}
