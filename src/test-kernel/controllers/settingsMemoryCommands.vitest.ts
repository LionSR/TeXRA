import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe } from 'vitest';

import { sessionFsLayer, type StorageFs } from '@platform/rootedFs';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { settingsMemoryCommands } from '@texra/controllers/settingsView/settingsMemoryCommands';
import type { SettingsViewOutboundMessage } from '@texra/shared/settingsView/settingsViewMessages';

import { createFakeUIHosts } from '../support/FakeHosts';
import { nodePlatformLayer } from '../support/fsTestUtils';

/** The Memory page over a capturing view; a reported failure fails the test. */
function createMemoryPage(options: { confirmResponses: readonly boolean[] }) {
  const posted: SettingsViewOutboundMessage[] = [];
  const { handlers } = settingsMemoryCommands({
    bindings: {
      post: (message) =>
        Effect.flatMap(message, (built) =>
          Effect.sync(() => {
            posted.push(built);
          }),
        ),
      prompt: createFakeUIHosts(options).prompt,
      openPath: () => Effect.void,
      revealPath: () => Effect.void,
    },
    present: {
      report: (_prefix, cause) => Effect.die(cause),
      reported: (_prefix, program) => Effect.orDie(program),
    },
  });
  return { handlers, posted };
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

const deleteNotes = {
  command: SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
  storagePath: 'memories/notes',
  displayPath: '/memories/notes',
} as const;

describe('settingsMemoryCommands', () => {
  it.effect('leaves memory files untouched when deletion is cancelled', () =>
    withMemoryTree((storage) =>
      Effect.gen(function* () {
        const page = createMemoryPage({ confirmResponses: [false] });

        yield* page.handlers.deleteMemory(deleteNotes);

        assert.deepEqual(page.posted, []);
        assert.equal(
          existsSync(path.join(storage, 'memories', 'notes', 'item.md')),
          true,
        );
      }),
    ),
  );
});
