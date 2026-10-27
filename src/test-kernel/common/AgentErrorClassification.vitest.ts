import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { RouteUnavailable } from '@common/errors/agentErrors';

const diskFull: NodeJS.ErrnoException = new Error('write failed');
diskFull.code = 'ENOSPC';

describe('classifyAgentError', () => {
  it.each([
    { label: 'a local ENOSPC failure', error: diskFull, kind: 'disk-full' },
    {
      // Model access fails with it where the credential is read; anything
      // that rethrows on top of it must stay classifiable.
      label: 'a missing key through a rewrapping cause chain',
      error: new Error('Failed to build the model client', {
        cause: new RouteUnavailable({
          reason: 'missing-api-key',
          message: 'Missing API key for openai.',
        }),
      }),
      kind: 'missing-api-key',
    },
    {
      label: 'an overflowed window by llm verdict',
      error: new ModelError({
        kind: 'context-overflow',
        message: 'Token count of message exceeds context window: 5 > 3',
      }),
      kind: 'context-window',
    },
  ])('classifies $label as $kind', ({ error, kind }) => {
    expect(classifyAgentError(error)).toBe(kind);
  });
});
