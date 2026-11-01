import { it } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { describe, expect } from 'vitest';

import { listRunGeneratedFiles } from '@texra-ai/harness/host';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import type { RunId } from '@texra-ai/harness/schemas';

describe('listRunGeneratedFiles', () => {
  // The run directory's own probe: a storage failure there is a fault, not
  // "this run produced nothing", so it reaches the caller's handler.
  it.effect('propagates a storage failure from the run-directory probe', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const failure = PlatformError.systemError({
        _tag: 'PermissionDenied',
        module: 'FileSystem',
        method: 'access',
        pathOrDescriptor: fakePath('storage'),
      });

      expect(
        yield* Effect.flip(
          listRunGeneratedFiles(
            'generated-history-test' as RunId,
            fakePath('storage'),
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              exists: () => Effect.fail(failure),
            }),
          ),
        ),
      ).toBe(failure);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
