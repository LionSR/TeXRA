/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, it as plainIt, vi } from 'vitest';

import { createFakeUIHosts } from '../support/FakeHosts';

const mocks = vi.hoisted(() => ({
  resolveMemoryStoragePath: vi.fn(
    (storagePath: string) => `mem/${storagePath}`,
  ),
  loadMemoryItems: vi.fn(),
  loadMemoryPreview: vi.fn(),
  setMemoryPinned: vi.fn(),
  // The real StorageFS.delete resolves a promise; the controller now awaits
  // it inside Effect.tryPromise, which needs a thenable back.
  storageDelete: vi.fn(async () => undefined),
}));

vi.mock('@platform/defaults/workspaceStorage', () => ({
  resolveMemoryStoragePath: mocks.resolveMemoryStoragePath,
}));

vi.mock('@tools/memory/memoryFileSystem', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tools/memory/memoryFileSystem')>();
  return {
    // The tagged filesystem failures stay real: the controller constructs
    // MemoryFileUnwritable around its own StorageFS.delete.
    ...actual,
    loadMemoryItems: mocks.loadMemoryItems,
    loadMemoryPreview: mocks.loadMemoryPreview,
    setMemoryPinned: mocks.setMemoryPinned,
  };
});

vi.mock('@utils/files/storageFS', () => ({
  StorageFS: {
    delete: mocks.storageDelete,
  },
}));

// Imported after vi.mock so the mocked dependencies are in place.
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

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
      assert.equal(mocks.storageDelete.mock.calls.length, 0);
    }),
  );

  it.effect('deletes confirmed memory files and returns refreshed data', () =>
    Effect.gen(function* () {
      mocks.loadMemoryItems.mockReturnValue(Effect.succeed([]));
      const { controller } = createController({ confirmResponses: [true] });

      const message = yield* controller.deleteMemory({
        storagePath: 'item.md',
        displayPath: 'item.md',
      });

      assert.deepEqual(mocks.storageDelete.mock.calls[0], [
        'mem/item.md',
        { recursive: true },
      ]);
      assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
    }),
  );

  it.effect(
    'warns and returns null when the pinned memory limit is reached',
    () =>
      Effect.gen(function* () {
        mocks.setMemoryPinned.mockReturnValue(
          Effect.succeed({ status: 'cap-reached' }),
        );
        const { controller, hosts } = createController();

        assert.equal(yield* controller.setMemoryPinned('item.md', true), null);
        assert.equal(hosts.prompt.messages.at(-1)?.kind, 'warning');
      }),
  );
});
