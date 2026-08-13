// Reasoning-phase boundaries for the OpenAI Responses stream processor.
//
// The thinking stream must open on the reasoning output item — not the first
// summary delta — so subscribers can surface "the model is thinking" even
// when no summary text ever streams (gpt-5 with summaries disabled), and it
// must close at every phase boundary so the indicator turns off.

import { describe, expect, it } from 'vitest';

import { noopTrace, type StreamHandle } from '@agent/trace';
import { ResponseStreamProcessor } from '@agent/modelHandlers/openai/ResponseStreamProcessor';
import type {
  Response,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

interface RecordedStream extends StreamHandle {
  readonly appended: string[];
  finalized: boolean;
}

function recordedStream(id: string): RecordedStream {
  const appended: string[] = [];
  return {
    id,
    appended,
    finalized: false,
    append(text: string) {
      appended.push(text);
    },
    finalize(finalText?: string) {
      this.finalized = true;
      return finalText ?? appended.join('');
    },
  };
}

function createProcessor() {
  const thinkingStreams: RecordedStream[] = [];
  const processor = new ResponseStreamProcessor({
    createThinkingStream: () => {
      const stream = recordedStream(`thinking-${thinkingStreams.length}`);
      thinkingStreams.push(stream);
      return stream;
    },
    createOutputStream: () => recordedStream('output'),
    extractText: () => '',
    emitWebSearchResult: () => undefined,
    logger: noopTrace,
  });
  return { processor, thinkingStreams };
}

function event(partial: Record<string, unknown>): ResponseStreamEvent {
  return partial as unknown as ResponseStreamEvent;
}

const reasoningAdded = event({
  type: 'response.output_item.added',
  item: { type: 'reasoning', id: 'rs_1', summary: [] },
  output_index: 0,
  sequence_number: 1,
});
const reasoningDone = event({
  type: 'response.output_item.done',
  item: { type: 'reasoning', id: 'rs_1', summary: [] },
  output_index: 0,
  sequence_number: 2,
});
const summaryDelta = event({
  type: 'response.reasoning_summary_text.delta',
  delta: 'weighing options',
  item_id: 'rs_1',
  output_index: 0,
  summary_index: 0,
  sequence_number: 3,
});
const functionArgsDone = event({
  type: 'response.function_call_arguments.done',
  name: 'search',
  arguments: '{}',
  item_id: 'fc_1',
  output_index: 1,
  sequence_number: 4,
});
const emptyResponse = { output: [] } as unknown as Response;

describe('ResponseStreamProcessor reasoning phases', () => {
  it('opens the thinking stream on the reasoning item, without any delta', () => {
    const { processor, thinkingStreams } = createProcessor();

    processor.process(reasoningAdded);

    expect(thinkingStreams).toHaveLength(1);
    expect(thinkingStreams[0]?.appended).toEqual([]);
    expect(thinkingStreams[0]?.finalized).toBe(false);

    processor.process(reasoningDone);

    expect(thinkingStreams[0]?.finalized).toBe(true);
  });

  it('appends summary deltas to the stream opened by the reasoning item', () => {
    const { processor, thinkingStreams } = createProcessor();

    processor.process(reasoningAdded);
    processor.process(summaryDelta);

    expect(thinkingStreams).toHaveLength(1);
    expect(thinkingStreams[0]?.appended).toEqual(['weighing options']);
  });

  it('opens a stream lazily when only deltas arrive', () => {
    const { processor, thinkingStreams } = createProcessor();

    processor.process(summaryDelta);

    expect(thinkingStreams).toHaveLength(1);
    expect(thinkingStreams[0]?.appended).toEqual(['weighing options']);
  });

  it('closes the phase when tool-call arguments complete', () => {
    const { processor, thinkingStreams } = createProcessor();

    processor.process(reasoningAdded);
    processor.process(functionArgsDone);

    expect(thinkingStreams[0]?.finalized).toBe(true);

    // A later reasoning segment opens a fresh stream.
    processor.process(reasoningAdded);
    expect(thinkingStreams).toHaveLength(2);
    expect(thinkingStreams[1]?.finalized).toBe(false);
  });

  it('closes any open phase at finalize', () => {
    const { processor, thinkingStreams } = createProcessor();

    processor.process(reasoningAdded);
    processor.finalize(emptyResponse);

    expect(thinkingStreams[0]?.finalized).toBe(true);
  });

  it('never opens a thinking stream when no reasoning happens', () => {
    const { processor, thinkingStreams } = createProcessor();

    processor.process(
      event({
        type: 'response.output_text.delta',
        delta: 'plain answer',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      }),
    );
    processor.finalize(emptyResponse);

    expect(thinkingStreams).toHaveLength(0);
  });
});
