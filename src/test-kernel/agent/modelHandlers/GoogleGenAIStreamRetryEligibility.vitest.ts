// Third-party imports
import { describe, expect, it } from 'vitest';
import { createPartFromText, type Content } from '@google/genai';
import { ModelProvider } from 'llm-zoo';

// Local imports - agent
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { noopTrace } from '@agent/trace/noopTrace';

// Local imports - common errors
import {
  detectPartialText,
  requiresFlowAutoRetry,
} from '@common/errors/sdkErrorUtils';

// Local imports - test fixtures
import { buildTestModelConfig } from './testFixtures';

class StreamingGoogleHandler extends ModelHandlerGoogleGenAI {
  override getStreamingConfig(): boolean {
    return true;
  }
}

function createStreamingHandler(): ModelHandlerGoogleGenAI {
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
  handler.setLogger({
    ...noopTrace,
    openStream: () => ({
      id: 'stream-1',
      append: () => undefined,
      finalize: (text?: string) => text ?? '',
    }),
  });
  handler.setOutputStreaming(true);
  return handler;
}

/**
 * A stream that yields one chunk of visible text, then throws mid-stream —
 * simulating a dropped connection *after* content has already been produced.
 * `streamConnected`-style formulas elsewhere (`connected || tail.length > 0`)
 * would mark this retry-eligible; GoogleGenAI must not.
 */
function createFakeClientWithMidStreamFailure(
  visibleText: string,
  failure: Error,
): any {
  return {
    chats: {
      create: () => ({
        sendMessageStream: async () =>
          (async function* () {
            const chunk: any = {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [createPartFromText(visibleText)],
                  },
                },
              ],
            };
            yield chunk;
            throw failure;
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

describe('ModelHandlerGoogleGenAI streaming retry eligibility', () => {
  it('never marks a mid-stream failure flow-auto-retry-eligible, even with a partial tail', async () => {
    const handler = createStreamingHandler();
    const failure = new Error('relay connection dropped mid-stream');

    const messages: Content[] = [
      { role: 'user', parts: [createPartFromText('Hi there')] },
    ];

    let caught: unknown;
    try {
      await handler.createResponse({
        client: createFakeClientWithMidStreamFailure(
          'partial text before the drop',
          failure,
        ),
        messages,
        temperature: 0,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(failure);
    // The tail must still be attached for the retry UI...
    expect(detectPartialText(failure)).toBe('partial text before the drop');
    // ...but GoogleGenAI's SDK never reaches the SDK-retry boundary, so this
    // must stay false regardless of tail/connection state. A template that
    // hardcoded `connected || tail.length > 0` would regress this to `true`.
    expect(requiresFlowAutoRetry(failure)).toBe(false);
  });
});
