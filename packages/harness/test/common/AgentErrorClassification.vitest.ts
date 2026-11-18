import { DatabaseSync } from 'node:sqlite';

import { classifySqliteError, SqlError } from 'effect/sql/SqlError';
import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import { RouteUnavailable } from '@texra-ai/harness/host';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { DatabaseWriteFailed } from '@shared/session/database';

const diskFull: NodeJS.ErrnoException = new Error('write failed');
diskFull.code = 'ENOSPC';

/** SQLite's own full disk (`SQLITE_FULL`) as the store's write raises it: a
 *  store capped at its current size takes one more page, and the driver's
 *  error is wrapped as the store wraps it. */
const storeFull = (() => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (v TEXT)');
    db.exec('PRAGMA max_page_count = 2');
    db.exec(`INSERT INTO t VALUES ('${'x'.repeat(8192)}')`);
    throw new Error('the capped store took the row');
  } catch (cause) {
    return new DatabaseWriteFailed({
      path: 'texra.db',
      cause: new SqlError({
        reason: classifySqliteError(cause, {
          message: 'Failed to execute statement',
        }),
      }),
    });
  } finally {
    db.close();
  }
})();

describe('classifyAgentError', () => {
  it.each([
    {
      label: 'a local ENOSPC failure',
      error: diskFull,
      expected: { kind: 'disk-full' },
    },
    {
      label: "the store's write on a full disk",
      error: storeFull,
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
