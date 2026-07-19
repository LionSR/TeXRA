// Third-party imports
import { describe, expect, it } from 'vitest';
import {
  FinishReason,
  GenerateContentResponse,
  createPartFromText,
  type Content,
} from '@google/genai';
import { ModelProvider } from 'llm-zoo';

// Local imports - test support and agent
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { noopTrace } from '@agent/trace/noopTrace';

type StreamRecord = {
  appends: string[];
  finalized?: string;
};

function createStreamRecorder(records: StreamRecord[]): AgentTrace {
  return {
    ...noopTrace,
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
  };
}

class StreamingGoogleHandler extends ModelHandlerGoogleGenAI {
  override getStreamingConfig(): boolean {
    return true;
  }
}

function createStreamingHandler(
  records: StreamRecord[],
): ModelHandlerGoogleGenAI {
  const handler = new StreamingGoogleHandler(
    buildTestModelConfig({
      name: 'test-google-model',
      label: 'Test Google Model',
      fullName: 'google/test',
      shortName: 'google/test',
      provider: ModelProvider.GOOGLE,
      contextWindow: 4096,
      capabilities: { supportsTokenCounting: false },
    }),
  );
  handler.setLogger(createStreamRecorder(records));
  handler.setOutputStreaming(true);
  return handler;
}

function createFakeClient(...chunks: GenerateContentResponse[]): any {
  return {
    chats: {
      create: () => ({
        sendMessageStream: async () =>
          (async function* () {
            for (const chunk of chunks) {
              yield chunk;
            }
          })(),
        sendMessage: async () => {
          throw new Error(
            'sendMessage should not be called when streaming is enabled',
          );
        },
      }),
    },
    models: {},
  };
}

describe('ModelHandlerGoogleGenAI streaming text extraction', () => {
  it('maps finalTool to an ANY function allow-list', async () => {
    const streamRecords: StreamRecord[] = [];
    const handler = createStreamingHandler(streamRecords);
    let chatConfig: Record<string, unknown> | undefined;
    const response = new GenerateContentResponse();
    response.candidates = [];
    const client = createFakeClient(response);
    client.chats.create = (params: { config: Record<string, unknown> }) => {
      chatConfig = params.config;
      return {
        sendMessageStream: async () =>
          (async function* () {
            yield response;
          })(),
      };
    };

    await handler.createResponse({
      client,
      messages: [{ role: 'user', parts: [createPartFromText('finish')] }],
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
      finalTool: { name: 'submit_output' },
    });

    expect(chatConfig?.toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['submit_output'],
      },
    });
    expect(handler.supportsForcedToolChoice).toBe(true);
  });

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

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hi there')] },
    ];

    const response = await handler.createResponse({
      client: createFakeClient(chunk),
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

  it('drops Google tool-call control glyphs from visible streamed text', async () => {
    const streamRecords: StreamRecord[] = [];
    const handler = createStreamingHandler(streamRecords);

    const chunk = new GenerateContentResponse();
    chunk.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            createPartFromText('\u25c4'),
            {
              functionCall: {
                id: 'google-call-1',
                name: 'executions',
                args: { action: 'wait', path: '/executions/example' },
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      } as any,
    ];

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('wait for subagent')] },
    ];

    const response = await handler.createResponse({
      client: createFakeClient(chunk),
      messages,
      temperature: 0,
    });

    expect(handler.extractResponse(response.response, '').text).toBe('');
    expect(streamRecords[1]?.appends).toEqual([]);
    expect(streamRecords[1]?.finalized).toBe('');

    const [toolInfo] = handler.extractToolUse(response.response);
    expect(toolInfo?.callId).toBe('google-call-1');
    expect(toolInfo?.name).toBe('executions');
    expect(toolInfo?.input).toEqual({
      action: 'wait',
      path: '/executions/example',
    });
  });

  it('drops Google tool-call control glyphs split before streamed function calls', async () => {
    const streamRecords: StreamRecord[] = [];
    const handler = createStreamingHandler(streamRecords);

    const glyphChunk = new GenerateContentResponse();
    glyphChunk.candidates = [
      {
        content: {
          role: 'model',
          parts: [createPartFromText('\u25c4')],
        },
      } as any,
    ];

    const toolChunk = new GenerateContentResponse();
    toolChunk.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'google-call-1',
                name: 'executions',
                args: { action: 'wait', path: '/executions/example' },
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      } as any,
    ];

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('wait for subagent')] },
    ];

    const response = await handler.createResponse({
      client: createFakeClient(glyphChunk, toolChunk),
      messages,
      temperature: 0,
    });

    expect(handler.extractResponse(response.response, '').text).toBe('');
    expect(streamRecords[1]?.appends).toEqual([]);
    expect(streamRecords[1]?.finalized).toBe('');

    const [toolInfo] = handler.extractToolUse(response.response);
    expect(toolInfo?.callId).toBe('google-call-1');
    expect(toolInfo?.name).toBe('executions');
    expect(toolInfo?.input).toEqual({
      action: 'wait',
      path: '/executions/example',
    });
  });
});
