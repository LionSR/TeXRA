// Third-party imports
import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

function createHandler(): ModelHandlerOpenAIResponse {
  const handler = new ModelHandlerOpenAIResponse(
    buildTestModelConfig({
      name: 'gpt-4.1',
      fullName: 'gpt-4.1',
      provider: ModelProvider.OPENAI,
    }),
  );
  handler.setLogger({ ...noopTrace });
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
