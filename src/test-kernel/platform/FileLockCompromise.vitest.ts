import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
}));

vi.mock('proper-lockfile', () => ({ lock: mocks.lock }));

import { nodeFileLocks } from '@platform/defaults/fileLocks';

describe('nodeFileLocks compromise boundary', () => {
  it.effect(
    'fails through withFileLock instead of throwing from the renewal callback',
    () =>
      Effect.gen(function* () {
        const compromised = Object.assign(
          new Error('lock directory disappeared'),
          {
            code: 'ECOMPROMISED',
          },
        );
        const alreadyReleased = Object.assign(
          new Error('lock already released'),
          {
            code: 'ERELEASED',
          },
        );
        mocks.lock.mockImplementationOnce(async () => async () => {
          throw alreadyReleased;
        });

        const result = yield* Effect.result(
          nodeFileLocks.withFileLock(
            join(tmpdir(), 'texra-file-lock-compromise'),
          )(
            Effect.sync(() => {
              const options = mocks.lock.mock.calls[0]?.[1] as {
                onCompromised: (error: Error) => void;
              };
              expect(() => options.onCompromised(compromised)).not.toThrow();
            }),
          ),
        );

        expect(Result.isFailure(result) && result.failure).toBe(compromised);
      }),
  );
});
