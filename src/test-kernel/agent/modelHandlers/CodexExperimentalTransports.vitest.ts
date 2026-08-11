import { afterEach, describe, expect, it } from 'vitest';
import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import { resetCodexCoordinator } from '@auth/codex';
import { AgentCategory } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Protected/private surface exercised by these tests via a narrow cast.
interface CodexInternals {
  storesResponsesServerSide: boolean;
  isWebSocketModeEnabled(): boolean;
  prepareWireParams(p: Record<string, unknown>): Record<string, unknown>;
  rebuildSparseResponseOutput(
    response: { output: unknown[]; output_text?: string },
    streamedItems: unknown[],
    streamedText: string,
  ): void;
}

function config(): ModelConfig {
  return buildTestModelConfig({
    name: 'gpt-5.5',
    fullName: 'gpt-5.5',
    shortName: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200_000,
    // Codex eligibility comes from the registry's codexSubscription flag
    // (see providerCapabilities.ts), not from tier/naming heuristics.
    capabilities: {
      supportsReasoning: true,
      reasoningEffort: ReasoningEffort.XHIGH,
    },
    openRouterOnly: false,
    codexSubscription: true,
  });
}

function initPlatformWith(opts: {
  config?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
}): Promise<void> {
  return installPlatform({
    config: {
      'texra.chatgptCodex.preferSubscription': true,
      ...opts.config,
    },
    globalState: opts.globalState,
  });
}

function workflowHandler(): ModelHandlerCodex {
  const handler = new ModelHandlerCodex(config());
  // Background mode is only eligible for workflow agents on GPT-family models.
  handler.setAgentCategory(AgentCategory.Workflow);
  return handler;
}

function internals(handler: ModelHandlerCodex): CodexInternals {
  return handler as unknown as CodexInternals;
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
    expect(internals(handler).storesResponsesServerSide).toBe(false);
    expect(internals(handler).isWebSocketModeEnabled()).toBe(false);
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
    expect(internals(handler).storesResponsesServerSide).toBe(false);
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
    expect(internals(handler).isWebSocketModeEnabled()).toBe(true);
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
    expect(internals(handler).storesResponsesServerSide).toBe(true);
  });

  it('enables WebSocket against the Codex backend from the global websocket toggle', async () => {
    await initPlatformWith({
      config: { 'texra.model.useBackgroundResponses': false },
      globalState: { 'texra.websocket.openai': true },
    });
    const handler = workflowHandler();

    expect(internals(handler).isWebSocketModeEnabled()).toBe(true);
  });

  it('rebuilds the sparse Codex completed response from streamed items/text', async () => {
    // The Codex backend's `response.completed` carries no output (verified
    // against the official Rust client: its Completed event has only
    // response_id/usage/end_turn, and it accumulates OutputItemDone). Both the
    // HTTP and WebSocket transports must rebuild `output`/`output_text` from the
    // streamed deltas — otherwise the whole turn, tool calls included, is lost.
    await initPlatformWith({});
    const handler = internals(workflowHandler());

    // A sparse completed response, as Codex returns it over WebSocket.
    const response = { output: [] as unknown[], output_text: undefined };
    const streamedItems = [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'delegate',
        arguments: '{"task":"review"}',
      },
    ];

    handler.rebuildSparseResponseOutput(response, streamedItems, 'hello world');

    // Tool call survives (this is what was being dropped on the WS path).
    expect(response.output).toEqual(streamedItems);
    expect(response.output_text).toBe('hello world');
  });

  it('applies the Codex wire rewrite on the WebSocket path (it bypasses codexFetch)', async () => {
    // Regression: the WebSocket transport sends params directly via the SDK and
    // never hits codexFetch, so without prepareWireParams the un-rewritten body
    // (here `max_output_tokens`) reaches Codex → 400 Unsupported parameter.
    await initPlatformWith({
      globalState: { 'texra.websocket.openai': true },
    });
    const handler = workflowHandler();

    const wire = internals(handler).prepareWireParams({
      model: 'gpt-5.5',
      max_output_tokens: 1024,
      input: [{ role: 'user', content: 'hi' }],
    });

    expect(wire).not.toHaveProperty('max_output_tokens');
    expect(wire.store).toBe(false);
    expect(wire.stream).toBe(true);
  });
});
