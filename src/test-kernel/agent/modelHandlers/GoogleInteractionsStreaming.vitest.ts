// Third-party imports
import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { GOOGLE_FINISH } from '@agent/types/StopReasonTypes';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Third-party imports
import type { Interactions } from '@google/genai';

type StreamRecord = {
  type: string;
  appends: string[];
  finalized?: string;
};

function createStreamRecorder(records: StreamRecord[]): AgentTrace {
  let counter = 0;
  return {
    ...noopTrace,
    openStream: (type: string) => {
      counter += 1;
      const record: StreamRecord = { type, appends: [] };
      records.push(record);
      return {
        id: `stream-${counter}`,
        append: (text: string) => record.appends.push(text),
        finalize: (text?: string) => {
          record.finalized = text;
          return text ?? record.appends.join('');
        },
      };
    },
  };
}

class StreamingInteractionsHandler extends ModelHandlerGoogleInteractions {
  override getStreamingConfig(): boolean {
    return true;
  }
}

function createHandler(
  records: StreamRecord[],
): ModelHandlerGoogleInteractions {
  const handler = new StreamingInteractionsHandler(
    buildTestModelConfig({
      name: 'test-google-interactions',
      label: 'Test Google Interactions',
      fullName: 'gemini-3-pro-test',
      shortName: 'gemini-3-pro-test',
      provider: ModelProvider.GOOGLE,
      contextWindow: 4096,
      capabilities: {
        supportsReasoning: true,
        supportsTokenCounting: false,
      },
    }),
  );
  handler.setLogger(createStreamRecorder(records));
  handler.setOutputStreaming(true);
  return handler;
}

function fakeClient(events: Interactions.InteractionSSEEvent[]): unknown {
  return {
    interactions: {
      create: async () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    },
    models: {},
  };
}

describe('ModelHandlerGoogleInteractions streaming', () => {
  it('routes text to output, thought summary to thinking, and captures signature', async () => {
    const records: StreamRecord[] = [];
    const handler = createHandler(records);

    const events: Interactions.InteractionSSEEvent[] = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'int_1', status: 'in_progress' },
      },
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      {
        event_type: 'step.delta',
        index: 0,
        delta: {
          type: 'thought_summary',
          content: { type: 'text', text: 'plan' },
        },
      },
      {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'thought_signature', signature: 'sig_abc' },
      },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'step.start',
        index: 1,
        step: { type: 'model_output' },
      },
      {
        event_type: 'step.delta',
        index: 1,
        delta: { type: 'text', text: 'Hello ' },
        metadata: {
          total_usage: { total_input_tokens: 10, total_output_tokens: 2 },
        },
      },
      {
        event_type: 'step.delta',
        index: 1,
        delta: { type: 'text', text: 'world' },
      },
      { event_type: 'step.stop', index: 1 },
      {
        event_type: 'interaction.completed',
        interaction: {
          id: 'int_1',
          status: 'completed',
          usage: {
            total_input_tokens: 10,
            total_output_tokens: 3,
            total_thought_tokens: 1,
          },
        },
      },
    ];

    const result = await handler.createResponse({
      client: fakeClient(events) as never,
      messages: [
        { type: 'user_input', content: [{ type: 'text', text: 'Hi' }] },
      ],
      temperature: 0,
    });

    expect(handler.extractResponse(result.response, '').text).toBe(
      'Hello world',
    );

    const outputRecord = records.find((r) => r.type === 'modelResponse');
    expect(outputRecord?.appends).toEqual(['Hello ', 'world']);
    expect(outputRecord?.finalized).toBe('Hello world');

    const thinkingRecord = records.find((r) => r.type === 'thinking');
    expect(thinkingRecord?.appends).toEqual(['plan']);

    // Thought signature is captured onto the round-trip ThoughtStep and persisted
    // into workspace reasoning state.
    const workspaceState = {
      reasoning: { thinkingAdded: false, thinkingBlocks: [] as unknown[] },
    } as unknown as AgentWorkspaceState;
    handler.processThinkingBlock(result.response, workspaceState);
    const blocks = workspaceState.reasoning.thinkingBlocks as Array<{
      signature?: string;
      thinking?: string;
    }>;
    expect(blocks[0]?.signature).toBe('sig_abc');
    expect(blocks[0]?.thinking).toBe('plan');

    // Final usage comes from the completed interaction.
    expect(result.response.usage?.total_input_tokens).toBe(10);
    expect(result.response.usage?.total_output_tokens).toBe(3);
    expect(result.response.status).toBe('completed');
  });

  it('reports incomplete when the stream ends without an interaction.completed event', async () => {
    const records: StreamRecord[] = [];
    const handler = createHandler(records);

    // A text turn that is cut off — no interaction.completed (or error) event.
    const events: Interactions.InteractionSSEEvent[] = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'int_x', status: 'in_progress' },
      },
      { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
      {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'text', text: 'partial' },
      },
      { event_type: 'step.stop', index: 0 },
    ];

    const result = await handler.createResponse({
      client: fakeClient(events) as never,
      messages: [
        { type: 'user_input', content: [{ type: 'text', text: 'go' }] },
      ],
      temperature: 0,
    });

    // Truncation is surfaced as `incomplete`, not silently `completed`.
    expect(result.response.status).toBe('incomplete');
    // extractResponse normalizes the 'incomplete' status to the canonical
    // MAX_TOKENS finish reason the shared continuation logic keys on.
    expect(handler.extractResponse(result.response, '').stopReason).toBe(
      GOOGLE_FINISH.MAX_TOKENS,
    );
  });

  it('declares manual compaction support (client-side compaction is implemented)', () => {
    const handler = createHandler([]);
    expect(handler.supportsManualCompaction).toBe(true);
  });
});
