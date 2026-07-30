/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
// Third-party imports
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, vi } from 'vitest';

// Local imports - test support
import { createFakeUIHosts } from '../support/FakeHosts';

const mocks = vi.hoisted(() => ({
  resolveMemoryStoragePath: vi.fn(
    (storagePath: string) => `mem/${storagePath}`,
  ),
  loadMemoryItems: vi.fn(),
  loadMemoryPreview: vi.fn(),
  setMemoryPinned: vi.fn(),
  storageDelete: vi.fn(),
}));

vi.mock('@platform/defaults/workspaceStorage', () => ({
  resolveMemoryStoragePath: mocks.resolveMemoryStoragePath,
}));

vi.mock('@tools/memory/memoryFileSystem', () => ({
  loadMemoryItems: mocks.loadMemoryItems,
  loadMemoryPreview: mocks.loadMemoryPreview,
  setMemoryPinned: mocks.setMemoryPinned,
}));

vi.mock('@utils/files', () => ({
  StorageFS: {
    delete: mocks.storageDelete,
  },
}));

// Imported after vi.mock so the mocked dependencies are in place.
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

function createController(options?: { memoryEnabled?: boolean }): {
  controller: SettingsMemoryController;
  hosts: ReturnType<typeof createFakeUIHosts>;
  memoryEnabledValue: () => boolean;
} {
  const hosts = createFakeUIHosts();
  let memoryEnabled = options?.memoryEnabled ?? true;

  return {
    controller: new SettingsMemoryController({
      prompt: hosts.prompt,
      isMemoryEnabled: () => memoryEnabled,
      setMemoryEnabled: async (enabled) => {
        memoryEnabled = enabled;
      },
    }),
    hosts,
    memoryEnabledValue: () => memoryEnabled,
  };
}

describe('SettingsMemoryController', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds memory data messages from core loadMemoryItems', async () => {
    mocks.loadMemoryItems.mockResolvedValue([
      {
        displayPath: 'item.md',
        storagePath: 'item.md',
        size: 13,
        mtime: '2026-05-03T00:00:00.000Z',
      },
    ]);
    const { controller } = createController();

    assert.deepEqual(await controller.getMemoryDataMessage(), {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
      items: [
        {
          displayPath: 'item.md',
          storagePath: 'item.md',
          size: 13,
          mtime: '2026-05-03T00:00:00.000Z',
        },
      ],
    });
  });

  it('builds preview messages through the resolved storage path', async () => {
    mocks.loadMemoryPreview.mockResolvedValue({
      storagePath: 'mem/item.md',
      lineCount: 1,
      preview: 'remember this',
    });
    const { controller } = createController();

    assert.deepEqual(await controller.getMemoryPreviewMessage('item.md'), {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: {
        storagePath: 'mem/item.md',
        lineCount: 1,
        preview: 'remember this',
      },
    });
  });

  it('builds preview error messages through the resolved storage path', () => {
    const { controller } = createController();

    assert.deepEqual(controller.getMemoryPreviewErrorMessage('item.md'), {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: {
        storagePath: 'mem/item.md',
        error: true,
      },
    });
  });

  it('updates memory enabled state and returns the refreshed setting', async () => {
    const { controller, memoryEnabledValue } = createController();

    assert.deepEqual(await controller.setMemoryEnabled(false), {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled: false,
    });
    assert.equal(memoryEnabledValue(), false);
  });

  it('leaves memory files untouched when deletion is cancelled', async () => {
    const hosts = createFakeUIHosts({ confirmResponses: [false] });
    const controller = new SettingsMemoryController({
      prompt: hosts.prompt,
      isMemoryEnabled: () => true,
      setMemoryEnabled: async () => undefined,
    });

    assert.equal(
      await controller.deleteMemory({
        storagePath: 'item.md',
        displayPath: 'item.md',
      }),
      null,
    );
    assert.equal(mocks.storageDelete.mock.calls.length, 0);
  });

  it('deletes confirmed memory files and returns refreshed data', async () => {
    mocks.loadMemoryItems.mockResolvedValue([]);
    const hosts = createFakeUIHosts({ confirmResponses: [true] });
    const controller = new SettingsMemoryController({
      prompt: hosts.prompt,
      isMemoryEnabled: () => true,
      setMemoryEnabled: async () => undefined,
    });

    const message = await controller.deleteMemory({
      storagePath: 'item.md',
      displayPath: 'item.md',
    });

    assert.deepEqual(mocks.storageDelete.mock.calls[0], [
      'mem/item.md',
      { recursive: true },
    ]);
    assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
  });

  it('pins memory files and returns refreshed data', async () => {
    mocks.setMemoryPinned.mockResolvedValue({
      status: 'changed',
      pinnedCount: 1,
    });
    mocks.loadMemoryItems.mockResolvedValue([]);
    const { controller } = createController();

    const message = await controller.pinMemory('item.md');

    assert.deepEqual(mocks.setMemoryPinned.mock.calls[0], [
      'mem/item.md',
      true,
    ]);
    assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
  });

  it('unpins memory files and returns refreshed data', async () => {
    mocks.setMemoryPinned.mockResolvedValue({
      status: 'changed',
      pinnedCount: 1,
    });
    mocks.loadMemoryItems.mockResolvedValue([]);
    const { controller } = createController();

    const message = await controller.unpinMemory('item.md');

    assert.deepEqual(mocks.setMemoryPinned.mock.calls[0], [
      'mem/item.md',
      false,
    ]);
    assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
  });

  it('refreshes without warning when the file is already in the requested state', async () => {
    mocks.setMemoryPinned.mockResolvedValue({ status: 'already' });
    mocks.loadMemoryItems.mockResolvedValue([]);
    const { controller, hosts } = createController();

    const message = await controller.pinMemory('item.md');

    assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
    assert.equal(hosts.prompt.messages.length, 0);
  });

  it('warns and returns null when the pinned memory limit is reached', async () => {
    mocks.setMemoryPinned.mockResolvedValue({ status: 'cap-reached' });
    const { controller, hosts } = createController();

    assert.equal(await controller.pinMemory('item.md'), null);
    assert.equal(hosts.prompt.messages.at(-1)?.kind, 'warning');
  });
});
