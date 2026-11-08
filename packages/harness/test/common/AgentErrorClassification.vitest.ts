import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import { RouteUnavailable } from '@texra-ai/harness/host';
import { classifyAgentError } from '@common/errors/agentErrorClassification';

const diskFull: NodeJS.ErrnoException = new Error('write failed');
diskFull.code = 'ENOSPC';

describe('classifyAgentError', () => {
  it.each([
    {
      label: 'a local ENOSPC failure',
      error: diskFull,
      expected: { kind: 'disk-full' },
    },
    {
      // Model access fails with it where the credential is read; anything
      // that rethrows on top of it must stay classifiable.
      label: 'a missing key through a rewrapping cause chain',
      error: new Error('Failed to build the model client', {
        cause: new RouteUnavailable({
          missingApiKey: true,
          message: 'Missing API key for openai.',
        }),
      }),
      expected: {
        kind: 'model',
        failure: { source: 'route', missingApiKey: true },
      },
    },
    {
      label: 'an overflowed window by llm verdict',
      error: new ModelError({
        kind: 'context-overflow',
        message: 'Token count of message exceeds context window: 5 > 3',
      }),
      expected: {
        kind: 'model',
        failure: { source: 'model', kind: 'context-overflow' },
      },
    },
  ])('classifies $label as $expected.kind', ({ error, expected }) => {
    expect(classifyAgentError(error)).toMatchObject(expected);
  });
});
