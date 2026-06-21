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
