import { describe, expect, it } from 'vitest';

import { sseToResponseJson } from '@agent/modelHandlers/openai/modelHandlerCodex';

describe('Codex SSE collapse', () => {
  it('returns the completed response as a successful collapse', () => {
    const result = sseToResponseJson(
      [
        'data: {"type":"response.output_text.delta","response":{"id":"partial"}}',
        '',
        'data: {"type":"response.completed","response":{"id":"final","status":"completed"}}',
        '',
        'data: [DONE]',
      ].join('\n'),
    );

    expect(result).toEqual({
      body: { id: 'final', status: 'completed' },
      status: 200,
    });
  });

  it('rebuilds an empty completed output from streamed output items (tool calls + text)', () => {
    const result = sseToResponseJson(
      [
        'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"read_file","arguments":"{}"}}',
        '',
        'data: {"type":"response.output_text.delta","delta":"Hi"}',
        '',
        'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}}',
        '',
        'data: {"type":"response.completed","response":{"id":"final","status":"completed","output":[]}}',
        '',
        'data: [DONE]',
      ].join('\n'),
    );

    expect(result?.status).toBe(200);
    const body = result?.body as {
      output?: { type?: string; name?: string }[];
    };
    expect(body.output).toHaveLength(2);
    expect(body.output?.[0]?.name).toBe('read_file');
    expect(body.output?.[1]?.type).toBe('message');
  });

  it('marks failed response events as unsuccessful', () => {
    const result = sseToResponseJson(
      [
        'data: {"type":"response.created","response":{"id":"partial"}}',
        '',
        'data: {"type":"response.failed","response":{"id":"failed","status":"failed","error":{"message":"backend failed"}}}',
        '',
        'data: [DONE]',
      ].join('\n'),
    );

    expect(result).toEqual({
      body: {
        id: 'failed',
        status: 'failed',
        error: { message: 'backend failed' },
      },
      status: 502,
    });
  });
});
