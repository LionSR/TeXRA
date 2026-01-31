// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { countTokens } from 'gpt-tokenizer';

// Local imports - agent
import { computeReducedMaxTokens } from '@agent/modelHandlers/contextManagementConstants';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

// Local imports - model config
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

function buildOpenAIResponseConfig(
  contextWindow: number,
  maxOutputTokens: number,
): ModelConfig {
  return {
    name: 'test-openai-response',
    fullName: 'gpt-test',
    provider: ModelProvider.OPENAI,
    maxOutputTokens,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  };
}

function createHandler(
  contextWindow: number,
  maxOutputTokens: number,
): ModelHandlerOpenAIResponse {
  return new ModelHandlerOpenAIResponse(
    buildOpenAIResponseConfig(contextWindow, maxOutputTokens),
  );
}

describe('ModelHandlerOpenAIResponse token heuristics', () => {
  it('reduces max_output_tokens when heuristic buffer would overflow', () => {
    const prompt = 'hello '.repeat(120);
    const textToCount = `user: ${prompt}\n`;
    const promptTokens = countTokens(textToCount);
    const contextWindow = promptTokens + 50;
    const maxOutputTokens = 100;
    const handler = createHandler(contextWindow, maxOutputTokens);
    const messages = [
      {
        type: 'message',
        role: 'user',
        content: prompt,
      },
    ];

    const { adjustedMaxOutputTokens, approximateInputTokens } = (
      handler as any
    ).applyTokenHeuristics(maxOutputTokens, messages);
    const heuristicBuffer = (handler as any).getHeuristicTokenBuffer();
    const expected = computeReducedMaxTokens(
      contextWindow - (approximateInputTokens as number),
      heuristicBuffer,
    );

    assert.equal(adjustedMaxOutputTokens, expected);
  });

  it('leaves max_output_tokens unchanged when within context window', () => {
    const prompt = 'short message';
    const contextWindow = 2048;
    const maxOutputTokens = 256;
    const handler = createHandler(contextWindow, maxOutputTokens);
    const messages = [
      {
        type: 'message',
        role: 'user',
        content: prompt,
      },
    ];

    const result = (handler as any).applyTokenHeuristics(
      maxOutputTokens,
      messages,
    );

    assert.equal(result.adjustedMaxOutputTokens, undefined);
    assert.equal(typeof result.approximateInputTokens, 'number');
  });
});
