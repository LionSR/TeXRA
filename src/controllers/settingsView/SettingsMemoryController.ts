// Local imports
import type { PromptHost } from '@hosts/uiHosts';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  MemoryPreview,
  MemoryViewItem,
} from '@shared/schemas/settingsViewMessages';
import type { MemoryFileMeta } from '@tools/memory/memoryMeta';

export interface SettingsMemoryStorage {
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export type SettingsMemoryMeta = MemoryFileMeta;

export interface SettingsMemoryControllerDeps {
  prompt: Pick<PromptHost, 'confirm' | 'warning'>;
  loadMemoryItems(): Promise<MemoryViewItem[]>;
  loadMemoryPreview(storagePath: string): Promise<MemoryPreview>;
  isMemoryEnabled(): boolean;
  setMemoryEnabled(enabled: boolean): Promise<void>;
  memoryStoragePath(storagePath: string): string;
  storage: SettingsMemoryStorage;
  maxPinnedMemories: number;
  parseMemoryFile(raw: string): {
    meta: SettingsMemoryMeta | null;
    content: string;
  };
  buildMemoryFile(content: string, meta: SettingsMemoryMeta | null): string;
  setPinnedMeta(
    meta: SettingsMemoryMeta | null,
    pinned: boolean,
  ): SettingsMemoryMeta;
  countPinnedMemories(maxCount: number): Promise<number>;
}

export type SettingsMemoryMessage =
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
      items: await this.deps.loadMemoryItems(),
    };
  }

  async getMemoryPreviewMessage(
    storagePath: string,
  ): Promise<SettingsMemoryMessage> {
    const resolvedPath = this.deps.memoryStoragePath(storagePath);
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: await this.deps.loadMemoryPreview(resolvedPath),
    };
  }

  getMemoryPreviewErrorMessage(storagePath: string): SettingsMemoryMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: {
        storagePath: this.deps.memoryStoragePath(storagePath),
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

    await this.deps.storage.delete(
      this.deps.memoryStoragePath(input.storagePath),
      {
        recursive: true,
      },
    );
    return this.getMemoryDataMessage();
  }

  async setMemoryEnabled(enabled: boolean): Promise<SettingsMemoryMessage> {
    await this.deps.setMemoryEnabled(enabled);
    return this.getMemoryEnabledMessage();
  }

  async pinMemory(storagePath: string): Promise<SettingsMemoryMessage | null> {
    return this.setMemoryPinned(storagePath, true);
  }

  async unpinMemory(
    storagePath: string,
  ): Promise<SettingsMemoryMessage | null> {
    return this.setMemoryPinned(storagePath, false);
  }

  private async setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<SettingsMemoryMessage | null> {
    const resolvedPath = this.deps.memoryStoragePath(storagePath);
    const raw = await this.deps.storage.read(resolvedPath);
    const { meta, content } = this.deps.parseMemoryFile(raw);

    const alreadyInState = pinned ? !!meta?.pinned : !meta?.pinned;
    if (alreadyInState) {
      return this.getMemoryDataMessage();
    }

    if (pinned) {
      const pinnedCount = await this.deps.countPinnedMemories(
        this.deps.maxPinnedMemories,
      );
      if (pinnedCount >= this.deps.maxPinnedMemories) {
        await this.deps.prompt.warning(
          `Cannot pin: maximum of ${this.deps.maxPinnedMemories} pinned memories reached. Unpin an existing memory first.`,
        );
        return null;
      }
    }

    const updatedMeta = this.deps.setPinnedMeta(meta, pinned);
    await this.deps.storage.write(
      resolvedPath,
      this.deps.buildMemoryFile(content, updatedMeta),
    );
    return this.getMemoryDataMessage();
  }
}
