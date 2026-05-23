import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import type { ModelConfig } from 'llm-zoo';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

function createLoggerStub(): Partial<AgentTrace> & { streamId: string } {
  return {
    streamId: 'test-channel',
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    logProgress: () => undefined,
    logContextManagement: () => undefined,
    withCurrentGroup: () => undefined,
    runWithinCurrentGroup: async <T>(fn: () => T | Promise<T>) => fn(),
    runWithGroup: async <T>(
      _groupId: string | undefined,
      fn: () => T | Promise<T>,
    ) => fn(),
  };
}

function createConfig(): ModelConfig {
  return {
    name: 'gpt-4.1',
    fullName: 'gpt-4.1',
    shortName: 'gpt-4.1',
    label: 'GPT 4.1',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsVision: false,
    },
    openRouterOnly: true,
  };
}

function createHandler(): ModelHandlerOpenAIResponse {
  const handler = new ModelHandlerOpenAIResponse(createConfig());
  handler.setLogger(createLoggerStub() as unknown as AgentTrace);
  return handler;
}

describe('ModelHandlerOpenAIResponse.extractAssistantText', () => {
  it('extracts assistant text from input and output text parts', () => {
    const handler = createHandler();
    const message = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'alpha' },
        { type: 'refusal', refusal: 'skip' },
        { type: 'input_text', text: ' beta' },
      ],
    } as unknown as ResponseInputItem;

    expect(handler.extractAssistantText(message)).toBe('alpha beta');
  });

  it('ignores non-assistant text parts', () => {
    const handler = createHandler();
    const message = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'not assistant text' }],
    } as unknown as ResponseInputItem;

    expect(handler.extractAssistantText(message)).toBeUndefined();
  });
});
