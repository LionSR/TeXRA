/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, vi } from 'vitest';

import { createFakeUIHosts } from '../support/FakeHosts';

const mocks = vi.hoisted(() => ({
  resolveMemoryStoragePath: vi.fn(
    (storagePath: string) => `mem/${storagePath}`,
  ),
  loadMemoryItems: vi.fn(),
  loadMemoryPreview: vi.fn(),
}));

vi.mock('@platform/defaults/workspaceStorage', () => ({
  resolveMemoryStoragePath: mocks.resolveMemoryStoragePath,
}));

vi.mock('@tools/memory/memoryFileSystem', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tools/memory/memoryFileSystem')>();
  return {
    // `deleteMemoryPath` stays real: it is the call whose target path and
    // options this suite pins, on the storage view provided below.
    ...actual,
    loadMemoryItems: mocks.loadMemoryItems,
    loadMemoryPreview: mocks.loadMemoryPreview,
  };
});

// Imported after vi.mock so the mocked dependencies are in place.
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { StorageFs } from '@platform/rootedFs';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

/** The session's storage view, with the one operation this suite exercises. */
const storageRemove = vi.fn(() => Effect.void);
const storageFsStub = {
  remove: storageRemove,
} as unknown as RootedFileSystem;

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

describe('SettingsMemoryController', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.effect('leaves memory files untouched when deletion is cancelled', () =>
    Effect.gen(function* () {
      const { controller } = createController({ confirmResponses: [false] });

      assert.equal(
        yield* controller.deleteMemory({
          storagePath: 'item.md',
          displayPath: 'item.md',
        }),
        null,
      );
      assert.equal(storageRemove.mock.calls.length, 0);
    }).pipe(Effect.provideService(StorageFs, storageFsStub)),
  );

  it.effect('deletes confirmed memory files and returns refreshed data', () =>
    Effect.gen(function* () {
      mocks.loadMemoryItems.mockReturnValue(Effect.succeed([]));
      const { controller } = createController({ confirmResponses: [true] });

      const message = yield* controller.deleteMemory({
        storagePath: 'item.md',
        displayPath: 'item.md',
      });

      assert.deepEqual(storageRemove.mock.calls[0], [
        'mem/item.md',
        { recursive: true },
      ]);
      assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
    }).pipe(Effect.provideService(StorageFs, storageFsStub)),
  );
});
