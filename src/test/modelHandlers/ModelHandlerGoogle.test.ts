// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { FinishReason } from '@google/genai';

// Local imports - agent
import type { AgentSetting } from '@agent/core/AgentDataclass';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';

// Local imports - model config
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from '@model/ModelConfig';

describe('ModelHandlerGoogleGenAI.shouldContinue', () => {
  const handler = new ModelHandlerGoogleGenAI({
    name: 'test-google-model',
    fullName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });

  const agentSetting = {
    endTag: '</doc>',
    documentTag: 'doc',
  } as AgentSetting;

  it('continues when FinishReason.MAX_TOKENS is returned without the end tag', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.MAX_TOKENS,
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, true);
  });

  it('stops when the end tag is present even if FinishReason.MAX_TOKENS was returned', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.MAX_TOKENS,
      'partial output</doc>',
      agentSetting,
    );

    assert.equal(shouldContinue, false);
  });

  it('does not continue when stop reason indicates a normal stop', () => {
    const shouldContinue = handler.shouldContinue(
      FinishReason.STOP,
      'partial output',
      agentSetting,
    );

    assert.equal(shouldContinue, false);
  });
});

describe('ModelHandlerGoogleGenAI.extractToolUse', () => {
  const handler = new ModelHandlerGoogleGenAI({
    name: 'test-google-model',
    fullName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });

  it('synthesizes tool call identifiers when missing', () => {
    const response: any = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: 'syk_v5.tex' },
                },
              },
            ],
          },
        },
      ],
    };

    const toolInfo = handler.extractToolUse(response);
    assert.ok(toolInfo, 'expected tool info to be returned');

    const parsed = JSON.parse(toolInfo as string);
    assert.equal(typeof parsed.id, 'string');
    assert.notEqual(parsed.id.trim(), '');
    assert.equal(parsed.call_id, parsed.id);
    assert.equal(parsed.tool_call_id, parsed.id);
    assert.equal(parsed.tool_use_id, parsed.id);
  });
});

describe('ModelHandlerGoogleGenAI.createToolUseFollowUpMessages', () => {
  const handler = new ModelHandlerGoogleGenAI({
    name: 'test-google-model',
    fullName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });

  it('omits unsupported identifier fields on follow-up function call parts', async () => {
    const messages = await handler.createToolUseFollowUpMessages(
      undefined,
      'call-123',
      'read_file',
      {
        name: 'read_file',
        args: { path: 'syk_v5.tex' },
      } as any,
      {},
      undefined,
    );

    const callMessage = messages[0];
    assert.ok(Array.isArray(callMessage.parts), 'expected call message parts');
    const callPart = callMessage.parts.find((part) => part.functionCall);
    assert.ok(callPart, 'expected a function call part');
    const functionCall = (callPart as any).functionCall as Record<
      string,
      unknown
    >;
    assert.equal(functionCall.id, 'call-123');
    assert.equal('call_id' in functionCall, false);
    assert.equal('tool_call_id' in functionCall, false);
    assert.equal('tool_use_id' in functionCall, false);
  });
});
