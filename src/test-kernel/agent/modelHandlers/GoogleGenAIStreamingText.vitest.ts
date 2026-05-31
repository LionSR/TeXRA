import { describe, expect, it } from 'vitest';
import {
  FinishReason,
  GenerateContentResponse,
  createPartFromText,
  type Content,
} from '@google/genai';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';

type StreamRecord = {
  appends: string[];
  finalized?: string;
};

function createConfig(): ModelConfig {
  return {
    name: 'test-google-model',
    label: 'Test Google Model',
    fullName: 'google/test',
    shortName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsTokenCounting: false,
    },
    openRouterOnly: false,
  };
}

function createLoggerStub(records: StreamRecord[]): AgentTrace {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    openStream: () => {
      const record: StreamRecord = { appends: [] };
      records.push(record);
      return {
        id: `stream-${records.length}`,
        append: (text: string) => {
          record.appends.push(text);
        },
        finalize: (text?: string) => {
          record.finalized = text;
          return text ?? record.appends.join('');
        },
      };
    },
  } as unknown as AgentTrace;
}

class StreamingGoogleHandler extends ModelHandlerGoogleGenAI {
  override getStreamingConfig(): boolean {
    return true;
  }
}

function createStreamingHandler(
  records: StreamRecord[],
): ModelHandlerGoogleGenAI {
  const handler = new StreamingGoogleHandler(createConfig());
  handler.setLogger(createLoggerStub(records));
  handler.setOutputStreaming(true);
  return handler;
}

describe('ModelHandlerGoogleGenAI streaming text extraction', () => {
  it('does not read the Google SDK text getter for streamed function calls', async () => {
    const streamRecords: StreamRecord[] = [];
    const handler = createStreamingHandler(streamRecords);

    const visibleText = 'I need to inspect files.';
    const chunk = new GenerateContentResponse();
    chunk.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            createPartFromText(visibleText),
            {
              functionCall: {
                id: 'google-call-1',
                name: 'list_files',
                args: { path: '.' },
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      } as any,
    ];
    Object.defineProperty(chunk, 'text', {
      configurable: true,
      get() {
        throw new Error('SDK text getter should not be used');
      },
    });

    const fakeClient = {
      chats: {
        create: () => ({
          sendMessageStream: async () =>
            (async function* () {
              yield chunk;
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

    expect(handler.extractResponse(response.response, '').text).toBe(
      visibleText,
    );
    expect(streamRecords[1]?.appends).toEqual([visibleText]);
    expect(streamRecords[1]?.finalized).toBe(visibleText);

    const [toolInfo] = handler.extractToolUse(response.response);
    expect(toolInfo?.callId).toBe('google-call-1');
    expect(toolInfo?.name).toBe('list_files');
    expect(toolInfo?.input).toEqual({ path: '.' });
  });
});
