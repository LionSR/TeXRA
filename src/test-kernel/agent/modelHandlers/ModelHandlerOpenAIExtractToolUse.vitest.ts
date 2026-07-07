// Standard library imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';

function buildConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'test-model',
    fullName: 'test-model',
    shortName: 'test-model',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
    label: 'Test Model',
    ...overrides,
  };
}

/**
 * #7467 regression: a malformed `tool_calls` payload from the provider used
 * to be swallowed inside `extractToolUse` (log + return []), which makes the
 * round look like "no tool calls" and lets the run finalize as a successful
 * completion on a corrupted response. It must now throw so the failure
 * reaches the L4 `classifyAgentError` boundary instead of mis-completing.
 */
describe('ModelHandlerOpenAI.extractToolUse', () => {
  it('throws on a malformed tool_calls payload instead of silently returning no tool calls', () => {
    const handler = new ModelHandlerOpenAI(buildConfig());

    // A tool call whose `type` isn't `function` is rejected by the OpenAI
    // SDK's own `assertToolCallsAreChatCompletionFunctionToolCalls` guard —
    // this is the shape of a genuinely corrupted provider response.
    const malformedResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'call_1', type: 'not_a_function' }],
          },
        },
      ],
    };

    assert.throws(
      () => handler.extractToolUse(malformedResponse as any),
      /Malformed OpenAI tool_calls payload/,
    );
  });

  it('still extracts well-formed tool calls', () => {
    const handler = new ModelHandlerOpenAI(buildConfig());

    const wellFormedResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              },
            ],
          },
        },
      ],
    };

    const toolCalls = handler.extractToolUse(wellFormedResponse as any);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'read_file');
    assert.equal(toolCalls[0].callId, 'call_1');
  });

  it('returns no tool calls when the response has none', () => {
    const handler = new ModelHandlerOpenAI(buildConfig());
    const noToolCallsResponse = {
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
    };
    assert.deepEqual(handler.extractToolUse(noToolCallsResponse as any), []);
  });
});
