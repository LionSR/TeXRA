// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports - test support and agent
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { noopTrace } from '@agent/trace/noopTrace';

/** A well-formed completion with a single `function` tool call. */
function completionWithValidToolCall() {
  return {
    id: 'test-completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'do_thing', arguments: '{}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  } as any;
}

/**
 * A malformed completion whose `tool_calls` entry has an unsupported
 * `type` — the shape a corrupted/unexpected provider payload produces.
 */
function completionWithMalformedToolCall() {
  return {
    id: 'test-completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'not_a_real_type' }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  } as any;
}

describe('ModelHandlerOpenAI.extractToolUse', () => {
  it('extracts a well-formed function tool call', () => {
    const handler = new ModelHandlerOpenAI(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities: { supportsVision: false },
      }),
    );
    handler.setLogger({ ...noopTrace });

    const result = handler.extractToolUse(completionWithValidToolCall());

    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, 'do_thing');
  });

  it('throws instead of silently returning no tool calls for a malformed payload', () => {
    // Regression test for #7467: previously this caught the parser's
    // assertion error and returned [], which the tool-use cycle read as
    // "the model made no tool calls" and finalized the run as a successful
    // completion despite the corrupted provider payload. It must now throw
    // so the run fails loudly via the classifyAgentError boundary instead.
    const handler = new ModelHandlerOpenAI(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities: { supportsVision: false },
      }),
    );
    handler.setLogger({ ...noopTrace });

    assert.throws(() =>
      handler.extractToolUse(completionWithMalformedToolCall()),
    );
  });
});

describe('ModelHandlerOpenAI forced tool choice', () => {
  it('maps finalTool to a named function choice', async () => {
    const handler = new ModelHandlerOpenAI(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities: { supportsVision: false },
      }),
    );
    handler.setLogger({ ...noopTrace });
    handler.getStreamingConfig = () => false;
    let request: Record<string, unknown> | undefined;

    await handler.createResponse({
      client: {
        chat: {
          completions: {
            create: async (params: Record<string, unknown>) => {
              request = params;
              return completionWithValidToolCall();
            },
          },
        },
      } as never,
      messages: [{ role: 'user', content: 'finish' }],
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
      finalTool: { name: 'submit_output' },
    });

    assert.deepEqual(request?.tool_choice, {
      type: 'function',
      function: { name: 'submit_output' },
    });
    assert.equal(handler.supportsForcedToolChoice, true);
  });
});
