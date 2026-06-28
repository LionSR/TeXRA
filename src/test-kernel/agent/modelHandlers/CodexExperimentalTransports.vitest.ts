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

  it('stays on the streaming path while the subscription is active, even with the background toggle on', async () => {
    // The Codex backend can't run background mode (store:false forced, no
    // polling endpoint), so the subscription path never enters it — the default
    // workflow request stays streaming regardless of the shared toggle.
    await initPlatformWith({
      config: { 'texra.model.useBackgroundResponses': true },
    });
    const handler = workflowHandler();

    expect(handler.isBackgroundModeActive()).toBe(false);
    expect(handler.getStreamingConfig()).toBe(true);
    expect(
      (handler as unknown as CodexInternals).storesResponsesServerSide,
    ).toBe(false);
  });

  it('keeps the background toggle from leaking into the request path on the subscription', async () => {
    // Regression: the request path used to read the background decision from a
    // separate predicate the Codex override couldn't reach, so background:true
    // was sent to a backend that rejects it (HTTP 400, no body). Both the
    // background toggle AND the websocket toggle on must still resolve to a
    // plain streaming request, never background.
    await initPlatformWith({
      config: { 'texra.model.useBackgroundResponses': true },
      globalState: { 'texra.websocket.openai': true },
    });
    const handler = workflowHandler();

    // The single decision the request path now reads.
    expect(handler.isBackgroundModeActive()).toBe(false);
    // Streaming stays on, and websocket is only chosen because background is off.
    expect(handler.getStreamingConfig()).toBe(true);
    expect(
      (handler as unknown as CodexInternals).isWebSocketModeEnabled(),
    ).toBe(true);
  });

  it('honors background mode on the fallback OpenAI-API-key path when the subscription is off', async () => {
    // Once the subscription preference is off the request runs on the user's
    // OpenAI API key with full base capabilities, so the shared toggle decides
    // background mode normally.
    await initPlatformWith({
      config: {
        'texra.chatgptCodex.preferSubscription': false,
        'texra.model.useBackgroundResponses': true,
      },
    });
    const handler = workflowHandler();

    expect(handler.isBackgroundModeActive()).toBe(true);
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
