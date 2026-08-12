// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, vi } from 'vitest';
import { type ModelConfig, ModelProvider } from 'llm-zoo';

// Local imports - agent
import { noopTrace } from '@agent/trace';
import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { resolveCodexSubscriptionProfile } from '@model/providerCapabilities';
import { AgentCategory } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as configModule from '@utils/config/configUtils';
import type OpenAI from 'openai';

class UnsupportedBackgroundHandler extends ModelHandlerOpenAIResponse {
  protected override backgroundModeSupported = false;
}

class ProfileDisabledBackgroundHandler extends ModelHandlerOpenAIResponse {
  protected override getActiveProviderCapabilities() {
    return resolveCodexSubscriptionProfile({
      model: { ...this.config, codexSubscription: true },
      useOpenRouter: false,
    });
  }
}

type OpenAIResponseHandlerClass = new (
  config: ModelConfig,
) => ModelHandlerOpenAIResponse;

async function captureBackgroundModeDebug(
  handler: ModelHandlerOpenAIResponse,
): Promise<string[]> {
  const messages: string[] = [];
  handler.setLogger({
    ...noopTrace,
    debug: (message) => messages.push(message),
  });
  handler.setAgentCategory(AgentCategory.Workflow);
  handler.getStreamingConfig = () => false;

  await handler.createResponse({
    client: {
      responses: {
        create: async () => ({
          id: 'response-1',
          output: [],
          output_text: 'ok',
          status: 'completed',
        }),
      },
    } as unknown as OpenAI,
    messages: [{ role: 'user', content: 'test' }],
    temperature: 0,
  });

  return messages;
}

function createOpenAIConfig(name: string): ModelConfig {
  return buildTestModelConfig({
    name,
    label: name,
    fullName: name,
    shortName: name,
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 10,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000,
    openRouterOnly: false,
  });
}

function createHandler(
  name: string,
  category: AgentCategory,
  HandlerClass: OpenAIResponseHandlerClass = ModelHandlerOpenAIResponse,
): ModelHandlerOpenAIResponse {
  const handler = new HandlerClass(createOpenAIConfig(name));
  handler.setAgentCategory(category);
  return handler;
}

function assertBackgroundMode(
  handler: ModelHandlerOpenAIResponse,
  active: boolean,
): void {
  assert.equal(handler.isBackgroundModeActive(), active);
  assert.equal(handler.getStreamingConfig(), !active);
}

describe('ModelHandlerOpenAIResponse background mode', () => {
  const originalGetConfig = configModule.getConfig;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables background mode by default only for GPT workflow agents', () => {
    assertBackgroundMode(createHandler('gpt-5', AgentCategory.Workflow), true);
  });

  it('keeps GPT tool-use agents on streaming requests by default', () => {
    assertBackgroundMode(createHandler('gpt-5', AgentCategory.ToolUse), false);
  });

  it('keeps non-GPT workflow agents on streaming requests by default', () => {
    assertBackgroundMode(createHandler('o3', AgentCategory.Workflow), false);
  });

  it('respects the background-mode toggle for GPT workflow agents', () => {
    vi.spyOn(configModule, 'getConfig').mockImplementation(
      <T>(key: string, defaultValue?: T): T => {
        if (key === 'texra.model.useBackgroundResponses') {
          return false as T;
        }
        return originalGetConfig(key, defaultValue);
      },
    );

    assertBackgroundMode(createHandler('gpt-5', AgentCategory.Workflow), false);
  });

  it('keeps streaming enabled when an eligible handler cannot use background mode', () => {
    assertBackgroundMode(
      createHandler(
        'gpt-5',
        AgentCategory.Workflow,
        UnsupportedBackgroundHandler,
      ),
      false,
    );
  });

  it('identifies handler support as the reason background mode is inactive', async () => {
    const messages = await captureBackgroundModeDebug(
      new UnsupportedBackgroundHandler(createOpenAIConfig('gpt-5')),
    );

    assert.ok(
      messages.some((message) =>
        message.includes('this handler does not support background execution'),
      ),
    );
  });

  it('identifies provider policy as the reason background mode is inactive', async () => {
    const messages = await captureBackgroundModeDebug(
      new ProfileDisabledBackgroundHandler(createOpenAIConfig('gpt-5')),
    );

    assert.ok(
      messages.some((message) =>
        message.includes(
          'active provider profile disables background execution',
        ),
      ),
    );
    assert.equal(
      messages.some((message) =>
        message.includes('this handler does not support background execution'),
      ),
      false,
    );
  });

  it('runs the Codex fallback (subscription off) path through the shared background toggle', () => {
    // With the subscription preference off (the default here — no platform
    // override sets it), ModelHandlerCodex drops to the base OpenAI-API-key
    // path, where background mode follows the shared useBackgroundResponses
    // toggle (default on) + workflow/GPT eligibility. The subscription-ON veto
    // (Codex backend can't poll) is covered in CodexExperimentalTransports.
    assertBackgroundMode(
      createHandler('gpt-5', AgentCategory.Workflow, ModelHandlerCodex),
      true,
    );
  });

  it('keeps Codex tool-use agents on streaming requests by default', () => {
    assertBackgroundMode(
      createHandler('gpt-5', AgentCategory.ToolUse, ModelHandlerCodex),
      false,
    );
  });

  it('reports Codex subscription usage without API-key spend', () => {
    const handler = new ModelHandlerCodex(createOpenAIConfig('gpt-5'));

    assert.equal(
      handler.computePrice({
        input_tokens: 10_000,
        output_tokens: 10_000,
      } as any),
      0,
    );
  });
});
