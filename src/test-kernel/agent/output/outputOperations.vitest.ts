// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, vi } from 'vitest';

// Local imports
import { tryOperation } from '@agent/output/outputOperations';
import type { AgentTrace } from '@agent/trace';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('tryOperation', () => {
  it('logs recoverable failures as internal by default', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as AgentTrace;

    const result = await tryOperation(
      async () => {
        throw new Error('boom');
      },
      {
        logger,
        level: 'warn',
        label: 'Output processing',
        recover: () => 'fallback',
      },
    );

    assert.equal(result, 'fallback');
    assert.deepEqual(warn.mock.calls, [
      ['Output processing: boom', { messageType: MESSAGE_TYPES.INTERNAL }],
    ]);
  });

  it('allows callers to keep warnings user-visible', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as AgentTrace;

    await tryOperation(
      async () => {
        throw new Error('visible');
      },
      {
        logger,
        level: 'warn',
        label: 'Compile check',
        messageType: MESSAGE_TYPES.DEFAULT,
        recover: () => undefined,
      },
    );

    assert.deepEqual(warn.mock.calls, [
      ['Compile check: visible', { messageType: MESSAGE_TYPES.DEFAULT }],
    ]);
  });
});
