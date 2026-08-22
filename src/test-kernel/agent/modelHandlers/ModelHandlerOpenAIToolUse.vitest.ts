// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

function newHandler(): ModelHandlerOpenAI {
  const handler = new ModelHandlerOpenAI(
    buildTestModelConfig({
      provider: ModelProvider.OPENAI,
      capabilities: { supportsVision: false },
    }),
  );
  handler.setLogger({ ...noopTrace });
  return handler;
}

function completionWithToolCalls(toolCalls: unknown[]) {
  return {
    id: 'test-completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  } as any;
}

const VALID_TOOL_CALL = {
  id: 'call_1',
  type: 'function',
  function: { name: 'do_thing', arguments: '{}' },
};

function completionWithValidToolCall() {
  return completionWithToolCalls([VALID_TOOL_CALL]);
}

describe('ModelHandlerOpenAI.extractToolUse', () => {
  it('extracts a well-formed function tool call', () => {
    const result = newHandler().extractToolUse(completionWithValidToolCall());

    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, 'do_thing');
  });

  it('throws instead of silently returning no tool calls for a malformed payload', () => {
    // Regression test for #7467: previously this caught the parser's
    // assertion error and returned [], which the tool-use cycle read as
    // "the model made no tool calls" and finalized the run as a successful
    // completion despite the corrupted provider payload. It must now throw
    // so the run fails loudly via the classifyAgentError boundary instead.
    const handler = newHandler();

    assert.throws(() =>
      handler.extractToolUse(
        completionWithToolCalls([{ id: 'call_1', type: 'not_a_real_type' }]),
      ),
    );
  });
});

describe('ModelHandlerOpenAI tool-result attachment summaries', () => {
  const attachments = [{ path: 'chart.png', mimeType: 'image/png' }] as never;
  const call = { raw: VALID_TOOL_CALL } as never;
  const result = { status: 'executed', output: 'done' } as const;

  it('follow-up path includes the attachment summary — regression for parallel tool calls silently dropping it', async () => {
    const messages = await newHandler().createBatchedToolUseFollowUpMessages([
      { call, result, attachments },
    ] as never);
    const toolMsg = messages.find((m) => m.role === 'tool') as any;
    assert.ok(String(toolMsg.content).includes('chart.png (image/png)'));
  });
});

describe('ModelHandlerOpenAI forced tool choice', () => {
  it('maps finalTool to a named function choice', async () => {
    const handler = newHandler();
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
