// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { tryOperation } from '@agent/output/outputOperations';
import { MESSAGE_TYPES } from '@shared/schemas';
import { spiedTrace } from '@test/support/spiedTrace';

describe('tryOperation', () => {
  it.each([
    {
      name: 'logs recoverable failures as internal by default',
      label: 'Output processing',
      message: 'boom',
      messageType: undefined,
      recover: () => 'fallback',
      expectedResult: 'fallback',
      loggedType: MESSAGE_TYPES.INTERNAL,
    },
    {
      name: 'allows callers to keep warnings user-visible',
      label: 'Compile check',
      message: 'visible',
      messageType: MESSAGE_TYPES.DEFAULT,
      recover: () => undefined,
      expectedResult: undefined,
      loggedType: MESSAGE_TYPES.DEFAULT,
    },
  ])(
    '$name',
    async ({
      label,
      message,
      messageType,
      recover,
      expectedResult,
      loggedType,
    }) => {
      const warn = vi.fn();
      const logger = spiedTrace({ warn }, { strict: true });

      const result = await tryOperation(
        async () => {
          throw new Error(message);
        },
        { logger, level: 'warn', label, messageType, recover },
      );

      expect(result).toBe(expectedResult);
      expect(warn).toHaveBeenCalledWith(`${label}: ${message}`, {
        messageType: loggedType,
      });
    },
  );
});
