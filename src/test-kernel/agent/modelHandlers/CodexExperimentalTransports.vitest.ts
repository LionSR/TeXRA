import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { resetCodexCoordinator } from '@auth/codex';

// Protected/private surface exercised by these tests via a narrow cast.
interface CodexInternals {
  storesResponsesServerSide: boolean;
  isWebSocketModeEnabled(): boolean;
}

function config(): ModelConfig {
  return {
    name: 'gpt-5.5',
    fullName: 'gpt-5.5',
    shortName: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200_000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsReasoning: true },
    openRouterOnly: false,
  };
}

async function initPlatformWith(opts: {
  config?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
}): Promise<void> {
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(
    createFakePlatform({
      config: {
        'texra.chatgptCodex.preferSubscription': true,
        ...opts.config,
      },
      globalState: opts.globalState,
    }),
  );
}

function workflowHandler(): ModelHandlerCodex {
  const handler = new ModelHandlerCodex(config());
  // Background mode is only eligible for workflow agents on GPT-family models.
  handler.setAgentCategory(AgentCategory.Workflow);
  return handler;
}

describe('Codex background/websocket transports follow the shared toggles', () => {
  afterEach(() => {
    resetCodexCoordinator();
  });

  it('stays streaming + store:false when the shared background toggle is off', async () => {
    await initPlatformWith({
      config: { 'texra.model.useBackgroundResponses': false },
    });
    const handler = workflowHandler();

    expect(handler.isBackgroundModeActive()).toBe(false);
    expect(handler.getStreamingConfig()).toBe(true);
    expect(
      (handler as unknown as CodexInternals).storesResponsesServerSide,
    ).toBe(false);
    expect(
      (handler as unknown as CodexInternals).isWebSocketModeEnabled(),
    ).toBe(false);
  });

  it('activates background mode (store:true, non-streaming) from the same useBackgroundResponses toggle', async () => {
    await initPlatformWith({
      config: { 'texra.model.useBackgroundResponses': true },
    });
    const handler = workflowHandler();

    expect(handler.isBackgroundModeActive()).toBe(true);
    // Background polls, so streaming is off and the response is stored server-side
    // (which also disables encrypted-reasoning replay — store:true path).
    expect(handler.getStreamingConfig()).toBe(false);
    expect(
      (handler as unknown as CodexInternals).storesResponsesServerSide,
    ).toBe(true);
  });

  it('enables WebSocket against the Codex backend from the global websocket toggle', async () => {
    await initPlatformWith({
      config: { 'texra.model.useBackgroundResponses': false },
      globalState: { 'texra.websocket.openai': true },
    });
    const handler = workflowHandler();

    expect(
      (handler as unknown as CodexInternals).isWebSocketModeEnabled(),
    ).toBe(true);
  });
});
