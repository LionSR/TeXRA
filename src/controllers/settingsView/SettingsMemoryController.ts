// Local imports
import type { PromptHost } from '@hosts/uiHosts';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { MemoryPreview, MemoryViewItem } from '@shared/schemas';
import { MAX_PINNED_MEMORIES } from '@tools/memory/constants';
import {
  loadMemoryItems,
  loadMemoryPreview,
  setMemoryPinned,
} from '@tools/memory/memoryFileSystem';
import { StorageFS } from '@utils/files/storageFS';

interface SettingsMemoryControllerDeps {
  prompt: Pick<PromptHost, 'confirm' | 'warning'>;
  isMemoryEnabled(): boolean;
  setMemoryEnabled(enabled: boolean): Promise<void>;
}

type SettingsMemoryMessage =
  | {
      command: typeof SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY;
      items: MemoryViewItem[];
    }
  | {
      command: typeof SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW;
      preview: MemoryPreview;
    }
  | {
      command: typeof SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED;
      enabled: boolean;
    };

export class SettingsMemoryController {
  constructor(private readonly deps: SettingsMemoryControllerDeps) {}

  async getMemoryDataMessage(): Promise<SettingsMemoryMessage> {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
      items: await loadMemoryItems(),
    };
  }

  async getMemoryPreviewMessage(
    storagePath: string,
  ): Promise<SettingsMemoryMessage> {
    const resolvedPath = resolveMemoryStoragePath(storagePath);
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: await loadMemoryPreview(resolvedPath),
    };
  }

  getMemoryPreviewErrorMessage(storagePath: string): SettingsMemoryMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: {
        storagePath: resolveMemoryStoragePath(storagePath),
        error: true,
      },
    };
  }

  getMemoryEnabledMessage(): SettingsMemoryMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled: this.deps.isMemoryEnabled(),
    };
  }

  async deleteMemory(input: {
    storagePath: string;
    displayPath: string;
  }): Promise<SettingsMemoryMessage | null> {
    const confirmed = await this.deps.prompt.confirm(
      `Delete "${input.displayPath}"?`,
      {
        modal: true,
        confirmLabel: 'Delete',
      },
    );
    if (!confirmed) return null;

    await StorageFS.delete(resolveMemoryStoragePath(input.storagePath), {
      recursive: true,
    });
    return this.getMemoryDataMessage();
  }

  async setMemoryEnabled(enabled: boolean): Promise<SettingsMemoryMessage> {
    await this.deps.setMemoryEnabled(enabled);
    return this.getMemoryEnabledMessage();
  }

  async setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<SettingsMemoryMessage | null> {
    const resolvedPath = resolveMemoryStoragePath(storagePath);
    const result = await setMemoryPinned(resolvedPath, pinned);
    if (result.status === 'cap-reached') {
      await this.deps.prompt.warning(
        `Cannot pin: maximum of ${MAX_PINNED_MEMORIES} pinned memories reached. Unpin an existing memory first.`,
      );
      return null;
    }
    return this.getMemoryDataMessage();
  }
}
