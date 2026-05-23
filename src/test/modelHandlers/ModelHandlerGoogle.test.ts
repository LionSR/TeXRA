// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import {
  FinishReason,
  GenerateContentResponse,
  createPartFromText,
} from '@google/genai';

// Local imports - agent
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';
import type { AgentSetting } from '@agent/core/AgentDataclass';
// Internal imports
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';

// Type imports
import type { Content } from '@google/genai';

describe('ModelHandlerGoogleGenAI.shouldContinue', () => {
  const handler = new ModelHandlerGoogleGenAI({
    name: 'test-google-model',
    label: 'Test Google Model',
    fullName: 'google/test',
    shortName: 'google/test',
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
    label: 'Test Google Model',
    fullName: 'google/test',
    shortName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });

  it('returns the SDK-provided tool call identifier', () => {
    const response: any = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: 'google-call-1',
                  name: 'read_file',
                  args: { path: 'syk_v5.tex' },
                },
              },
            ],
          },
        },
      ],
    };

    const [toolInfo] = handler.extractToolUse(response);
    assert.ok(toolInfo, 'expected tool info to be returned');

    assert.equal(toolInfo?.callId, 'google-call-1');
    assert.equal(toolInfo?.name, 'read_file');
    assert.deepEqual(toolInfo?.input, { path: 'syk_v5.tex' });
  });
});

describe('ModelHandlerGoogleGenAI.createToolUseFollowUpMessages', () => {
  const handler = new ModelHandlerGoogleGenAI({
    name: 'test-google-model',
    label: 'Test Google Model',
    fullName: 'google/test',
    shortName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });

  it('omits unsupported identifier fields on follow-up function call parts', async () => {
    const providerCall = {
      provider: 'google',
      callId: 'call-123',
      name: 'read_file',
      input: { path: 'syk_v5.tex' },
      raw: { id: 'call-123', name: 'read_file', args: { path: 'syk_v5.tex' } },
    } as const;

    const messages = await handler.createToolUseFollowUpMessages(
      undefined,
      providerCall,
      {},
      [],
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

describe('ModelHandlerGoogleGenAI.createResponse', () => {
  it('strips unsupported identifier fields before issuing chat history', async () => {
    const handler = new ModelHandlerGoogleGenAI({
      name: 'test-google-model',
      label: 'Test Google Model',
      fullName: 'google/test',
      shortName: 'google/test',
      provider: ModelProvider.GOOGLE,
      maxOutputTokens: 1024,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 4096,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    });

    (handler as any).capabilities.supportsTokenCounting = false;
    (handler as any).logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      statistics: () => {},
    };
    (handler as any).getStreamingConfig = () => false;

    const capturedHistory: Content[][] = [];
    const fakeClient = {
      chats: {
        create: (params: any) => {
          capturedHistory.push(params.history);
          return {
            sendMessage: async () => new GenerateContentResponse(),
            sendMessageStream: async () => {
              throw new Error('streaming not expected in unit test');
            },
          };
        },
      },
      models: {},
    } as any;

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hello')] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'ls',
              args: {},
              call_id: 'abc',
              tool_call_id: 'abc',
              tool_use_id: 'abc',
            } as any,
          },
        ],
      },
      { role: 'user', parts: [createPartFromText('Continue?')] },
    ];

    await handler.createResponse({
      client: fakeClient,
      messages,
      temperature: 0,
    });

    assert.equal(
      capturedHistory.length,
      1,
      'expected one chat history payload',
    );
    const history = capturedHistory[0];
    assert.ok(Array.isArray(history), 'expected captured history array');
    const modelEntry = history[1];
    assert.ok(modelEntry, 'expected model entry in history');
    assert.ok(
      Array.isArray(modelEntry.parts),
      'expected parts array on model entry',
    );
    const callPart = (modelEntry.parts as any[]).find(
      (part) => part && typeof part === 'object' && 'functionCall' in part,
    );
    assert.ok(callPart, 'expected function call part in model entry');
    const functionCall = (callPart as any).functionCall as Record<
      string,
      unknown
    >;
    assert.equal('call_id' in functionCall, false);
    assert.equal('tool_call_id' in functionCall, false);
    assert.equal('tool_use_id' in functionCall, false);
  });

  it('aggregates streamed chunks without relying on SDK response promises', async () => {
    const handler = new ModelHandlerGoogleGenAI({
      name: 'test-google-model',
      label: 'Test Google Model',
      fullName: 'google/test',
      shortName: 'google/test',
      provider: ModelProvider.GOOGLE,
      maxOutputTokens: 1024,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 4096,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    });

    (handler as any).capabilities.supportsTokenCounting = false;
    handler.setOutputStreaming(true);
    (handler as any).logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      statistics: () => {},
      createStream: () => ({
        append: () => {},
        finalize: () => {},
      }),
    };
    (handler as any).getStreamingConfig = () => true;

    const chunkOne = new GenerateContentResponse();
    chunkOne.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('Hello')],
        },
      } as any,
    ];
    const chunkTwo = new GenerateContentResponse();
    chunkTwo.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText(' world')],
        },
        finishReason: FinishReason.STOP,
      } as any,
    ];
    chunkTwo.usageMetadata = {
      inputTokenCount: 1,
      outputTokenCount: 2,
      totalTokenCount: 3,
    } as any;

    const fakeClient = {
      chats: {
        create: () => ({
          sendMessageStream: async () =>
            (async function* () {
              yield chunkOne;
              yield chunkTwo;
            })(),
          sendMessage: async () => {
            throw new Error(
              'sendMessage should not be called when streaming is enabled',
            );
          },
        }),
      },
      models: {},
    } as any;

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hi there')] },
    ];

    const response = await handler.createResponse({
      client: fakeClient,
      messages,
      temperature: 0,
    });

    assert.ok(response, 'expected a response to be returned');
    const candidate = response.response.candidates?.[0];
    assert.ok(candidate, 'expected a candidate in the aggregated response');
    assert.equal(
      candidate.content?.parts?.length,
      2,
      'expected both streamed parts to be present',
    );
    assert.equal(response.response.text, 'Hello world');
    assert.equal(candidate.finishReason, FinishReason.STOP);
    assert.deepEqual(response.response.usageMetadata, chunkTwo.usageMetadata);
  });

  it('concatenates automaticFunctionCallingHistory across streamed chunks', async () => {
    const handler = new ModelHandlerGoogleGenAI({
      name: 'test-google-model',
      label: 'Test Google Model',
      fullName: 'google/test',
      shortName: 'google/test',
      provider: ModelProvider.GOOGLE,
      maxOutputTokens: 1024,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 4096,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    });

    (handler as any).capabilities.supportsTokenCounting = false;
    handler.setOutputStreaming(true);
    (handler as any).logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      statistics: () => {},
      createStream: () => ({
        append: () => {},
        finalize: () => {},
      }),
    };
    (handler as any).getStreamingConfig = () => true;

    const chunkOne = new GenerateContentResponse();
    chunkOne.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('First')],
        },
      } as any,
    ];
    chunkOne.automaticFunctionCallingHistory = [{ name: 'callOne' } as any];

    const chunkTwo = new GenerateContentResponse();
    chunkTwo.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('Second')],
        },
      } as any,
    ];
    chunkTwo.automaticFunctionCallingHistory = [{ name: 'callTwo' } as any];

    const fakeClient = {
      chats: {
        create: () => ({
          sendMessageStream: async () =>
            (async function* () {
              yield chunkOne;
              yield chunkTwo;
            })(),
          sendMessage: async () => {
            throw new Error(
              'sendMessage should not be called when streaming is enabled',
            );
          },
        }),
      },
      models: {},
    } as any;

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hi there')] },
    ];

    const response = await handler.createResponse({
      client: fakeClient,
      messages,
      temperature: 0,
    });

    assert.ok(response.response.automaticFunctionCallingHistory);
    assert.equal(response.response.automaticFunctionCallingHistory?.length, 2);
    assert.deepEqual(response.response.automaticFunctionCallingHistory?.[0], {
      name: 'callOne',
    });
    assert.deepEqual(response.response.automaticFunctionCallingHistory?.[1], {
      name: 'callTwo',
    });
  });
});
