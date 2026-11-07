import { it } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { describe, expect } from 'vitest';

import { listRunGeneratedFiles } from '@texra-ai/harness/host';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';
import type { RunId } from '@texra-ai/harness/schemas';

describe('listRunGeneratedFiles', () => {
  // The run directory's own probe: a storage failure there is a fault, not
  // "this run produced nothing", so it reaches the caller's handler.
  it.effect('propagates a storage failure from the run-directory probe', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storage = (yield* FakeHost).path('storage');
      const failure = PlatformError.systemError({
        _tag: 'PermissionDenied',
        module: 'FileSystem',
        method: 'access',
        pathOrDescriptor: storage,
      });

      expect(
        yield* Effect.flip(
          listRunGeneratedFiles(
            // cast: a fixture run id; the listing only names a directory with it.
            'generated-history-test' as RunId,
            storage,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              exists: () => Effect.fail(failure),
            }),
          ),
        ),
      ).toBe(failure);
    }).pipe(
      Effect.provide(nodePlatformLayer),
      Effect.provide(FakeHost.layer()),
    ),
  );
});
