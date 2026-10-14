import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe } from 'vitest';

import { sessionFsLayer, type StorageFs } from '@platform/rootedFs';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { SettingsMemoryController } from '@texra/controllers/settingsView/SettingsMemoryController';

import { createFakeUIHosts } from '../support/FakeHosts';
import { nodePlatformLayer } from '../support/fsTestUtils';

function createController(options?: {
  confirmResponses?: readonly boolean[];
}): {
  controller: SettingsMemoryController;
  hosts: ReturnType<typeof createFakeUIHosts>;
} {
  const hosts = createFakeUIHosts({
    confirmResponses: options?.confirmResponses,
  });

  return {
    controller: new SettingsMemoryController({ prompt: hosts.prompt }),
    hosts,
  };
}

/**
 * Runs `test` over a temp storage root whose memory tree holds a folder,
 * `memories/notes/` (one file inside), and a file beside it,
 * `memories/keep.md`. `test` gets the storage root's absolute path.
 */
const withMemoryTree = <A, E>(
  test: (storage: string) => Effect.Effect<A, E, StorageFs>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const storage = yield* Effect.orDie(
      Effect.gen(function* () {
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: 'texra-settings-memory-',
        });
        yield* fs.makeDirectory(path.join(root, 'memories', 'notes'), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(root, 'memories', 'notes', 'item.md'),
          'note',
        );
        yield* fs.writeFileString(
          path.join(root, 'memories', 'keep.md'),
          'keep',
        );
        return root;
      }),
    );
    return yield* test(storage).pipe(
      Effect.provide(sessionFsLayer({ workspace: undefined, storage })),
    );
  }).pipe(Effect.scoped, Effect.provide(nodePlatformLayer));

describe('SettingsMemoryController', () => {
  it.effect('leaves memory files untouched when deletion is cancelled', () =>
    withMemoryTree((storage) =>
      Effect.gen(function* () {
        const { controller } = createController({ confirmResponses: [false] });

        assert.equal(
          yield* controller.deleteMemory({
            storagePath: 'memories/notes',
            displayPath: '/memories/notes',
          }),
          null,
        );
        assert.equal(
          existsSync(path.join(storage, 'memories', 'notes', 'item.md')),
          true,
        );
      }),
    ),
  );

  it.effect('deletes confirmed memory files and returns refreshed data', () =>
    withMemoryTree((storage) =>
      Effect.gen(function* () {
        const { controller } = createController({ confirmResponses: [true] });

        const message = yield* controller.deleteMemory({
          storagePath: 'memories/notes',
          displayPath: '/memories/notes',
        });

        // The folder goes with its contents (a recursive remove), inside the
        // session's storage root; the file beside it stays.
        assert.equal(
          existsSync(path.join(storage, 'memories', 'notes')),
          false,
        );
        assert.equal(
          existsSync(path.join(storage, 'memories', 'keep.md')),
          true,
        );
        assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
        assert.deepEqual(
          message?.items.map((item) => item.storagePath),
          ['memories/keep.md'],
        );
      }),
    ),
  );
});
