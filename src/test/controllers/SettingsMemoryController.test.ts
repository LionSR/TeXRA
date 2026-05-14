// Standard library imports
import { strict as assert } from 'assert';

// Local imports - common
import {
  SettingsMemoryController,
  type SettingsMemoryMeta,
  type SettingsMemoryStorage,
} from '@controllers/settingsView/SettingsMemoryController';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';

// Local imports - test support
import { createFakeUIHosts } from '../support/FakeHosts';

// Local imports - controllers

function buildMemoryFile(content: string, meta: SettingsMemoryMeta | null) {
  if (!meta) return content;
  return [
    `modifiedBy=${meta.modifiedBy}`,
    `modifiedAt=${meta.modifiedAt}`,
    `pinned=${meta.pinned ? 'true' : 'false'}`,
    '',
    content,
  ].join('\n');
}

function parseMemoryFile(raw: string): {
  meta: SettingsMemoryMeta | null;
  content: string;
} {
  if (!raw.includes('\n\n')) return { meta: null, content: raw };
  const [header, content] = raw.split('\n\n', 2);
  const fields = Object.fromEntries(
    header.split('\n').map((line) => line.split('=', 2)),
  );
  return {
    meta: {
      modifiedBy: fields.modifiedBy ?? 'codex',
      modifiedAt: fields.modifiedAt ?? '2026-05-03T00:00:00.000Z',
      pinned: fields.pinned === 'true',
    },
    content,
  };
}

function createController(options?: {
  confirmResponses?: boolean[];
  memoryEnabled?: boolean;
  pinnedCount?: number;
  memoryFile?: string;
}): {
  controller: SettingsMemoryController;
  deleted: string[];
  files: Map<string, string>;
  hosts: ReturnType<typeof createFakeUIHosts>;
  memoryEnabledValue: () => boolean;
} {
  const hosts = createFakeUIHosts({
    confirmResponses: options?.confirmResponses,
  });
  const files = new Map<string, string>([
    [
      'mem/item.md',
      options?.memoryFile ??
        buildMemoryFile('remember this', {
          modifiedBy: 'codex',
          modifiedAt: '2026-05-03T00:00:00.000Z',
          pinned: false,
        }),
    ],
  ]);
  const deleted: string[] = [];
  let memoryEnabled = options?.memoryEnabled ?? true;
  const storage: SettingsMemoryStorage = {
    delete: async (path) => {
      deleted.push(path);
      files.delete(path);
    },
    read: async (path) => {
      const value = files.get(path);
      if (value == null) throw new Error(`Missing file: ${path}`);
      return value;
    },
    write: async (path, content) => {
      files.set(path, content);
    },
  };

  return {
    controller: new SettingsMemoryController({
      prompt: hosts.prompt,
      loadMemoryItems: async () => [
        {
          displayPath: 'item.md',
          storagePath: 'item.md',
          size: 13,
          mtime: '2026-05-03T00:00:00.000Z',
        },
      ],
      loadMemoryPreview: async (storagePath) => ({
        storagePath,
        lineCount: 1,
        preview: 'remember this',
      }),
      isMemoryEnabled: () => memoryEnabled,
      setMemoryEnabled: async (enabled) => {
        memoryEnabled = enabled;
      },
      resolveStoragePath: (storagePath) => `mem/${storagePath}`,
      storage,
      maxPinnedMemories: 3,
      parseMemoryFile,
      buildMemoryFile,
      setPinnedMeta: (meta, pinned) => ({
        ...(meta ?? {
          modifiedBy: 'codex',
          modifiedAt: '2026-05-03T00:00:00.000Z',
        }),
        pinned,
      }),
      countPinnedMemories: async () => options?.pinnedCount ?? 0,
    }),
    deleted,
    files,
    hosts,
    memoryEnabledValue: () => memoryEnabled,
  };
}

describe('SettingsMemoryController', () => {
  it('builds memory data messages from the injected loader', async () => {
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
    const { controller, deleted } = createController({
      confirmResponses: [false],
    });

    assert.equal(
      await controller.deleteMemory({
        storagePath: 'item.md',
        displayPath: 'item.md',
      }),
      null,
    );
    assert.deepEqual(deleted, []);
  });

  it('deletes confirmed memory files and returns refreshed data', async () => {
    const { controller, deleted } = createController({
      confirmResponses: [true],
    });

    const message = await controller.deleteMemory({
      storagePath: 'item.md',
      displayPath: 'item.md',
    });

    assert.deepEqual(deleted, ['mem/item.md']);
    assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
  });

  it('pins memory files without VS Code dependencies', async () => {
    const { controller, files } = createController();

    const message = await controller.pinMemory('item.md');
    const { meta, content } = parseMemoryFile(files.get('mem/item.md') ?? '');

    assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
    assert.equal(meta?.pinned, true);
    assert.equal(content, 'remember this');
  });

  it('unpins memory files without VS Code dependencies', async () => {
    const { controller, files } = createController({
      memoryFile: buildMemoryFile('remember this', {
        modifiedBy: 'codex',
        modifiedAt: '2026-05-03T00:00:00.000Z',
        pinned: true,
      }),
    });

    const message = await controller.unpinMemory('item.md');
    const { meta } = parseMemoryFile(files.get('mem/item.md') ?? '');

    assert.equal(message?.command, SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY);
    assert.equal(meta?.pinned, false);
  });

  it('warns and skips writes when the pinned memory limit is reached', async () => {
    const { controller, files, hosts } = createController({
      pinnedCount: 3,
    });
    const before = files.get('mem/item.md');

    assert.equal(await controller.pinMemory('item.md'), null);
    assert.equal(files.get('mem/item.md'), before);
    assert.equal(hosts.prompt.messages.at(-1)?.kind, 'warning');
  });
});
