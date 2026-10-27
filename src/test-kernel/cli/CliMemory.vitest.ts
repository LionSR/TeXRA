// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, FileSystem } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { loadCliMemoryDetail } from '@cli/runtime/memory';
import { sessionFsLayer, type StorageFs } from '@platform/rootedFs';
import { nodePlatformLayer } from '@test/support/fsTestUtils';

/** Runs `program` over a temp storage root holding one stored memory,
 *  `memories/project.md`, whose whole text is `preview`. */
const withStoredMemory = <A, E>(
  program: Effect.Effect<A, E, StorageFs>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const storage = yield* Effect.orDie(
      Effect.gen(function* () {
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: 'texra-cli-memory-',
        });
        yield* fs.makeDirectory(path.join(root, 'memories'));
        yield* fs.writeFileString(
          path.join(root, 'memories', 'project.md'),
          'preview',
        );
        return root;
      }),
    );
    return yield* program.pipe(
      Effect.provide(sessionFsLayer({ workspace: undefined, storage })),
    );
  }).pipe(Effect.scoped, Effect.provide(nodePlatformLayer));

/** The squashed failure an exit carries, or undefined when it succeeded. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe('CLI memory formatting', () => {
  it.effect('rejects absolute paths outside the memory display root', () =>
    Effect.gen(function* () {
      const error = failureOf(
        yield* Effect.exit(loadCliMemoryDetail('/memoriesExtra')),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Invalid memory path');
    }).pipe(withStoredMemory),
  );
});
