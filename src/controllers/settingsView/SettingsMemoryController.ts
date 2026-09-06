import { Data, Effect } from 'effect';

import type { PromptHost } from '@hosts/uiHosts';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { MemoryPreview, MemoryViewItem } from '@shared/schemas';
import { MAX_PINNED_MEMORIES } from '@tools/memory/constants';
import {
  loadMemoryItems,
  loadMemoryPreview,
  MemoryFileUnwritable,
  setMemoryPinned,
} from '@tools/memory/memoryFileSystem';
import { StorageFS } from '@utils/files/storageFS';

interface SettingsMemoryControllerDeps {
  prompt: Pick<PromptHost, 'confirm' | 'warning'>;
}

/** A host prompt (the delete confirmation, the pin-cap warning) rejected. */
class MemoryPromptFailed extends Data.TaggedError('MemoryPromptFailed')<{
  readonly cause: unknown;
}> {}

type SettingsMemoryMessage =
  | {
      command: typeof SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY;
      items: MemoryViewItem[];
    }
  | {
      command: typeof SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW;
      preview: MemoryPreview;
    };

export class SettingsMemoryController {
  constructor(private readonly deps: SettingsMemoryControllerDeps) {}

  readonly getMemoryDataMessage = Effect.fn(
    'SettingsMemoryController.getMemoryDataMessage',
  )(function* () {
    const items = yield* loadMemoryItems();
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
      items,
    } satisfies SettingsMemoryMessage;
  });

  readonly getMemoryPreviewMessage = Effect.fn(
    'SettingsMemoryController.getMemoryPreviewMessage',
  )(function* (storagePath: string) {
    const resolvedPath = resolveMemoryStoragePath(storagePath);
    const preview = yield* loadMemoryPreview(resolvedPath);
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview,
    } satisfies SettingsMemoryMessage;
  });

  getMemoryPreviewErrorMessage(storagePath: string): SettingsMemoryMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: {
        storagePath: resolveMemoryStoragePath(storagePath),
        error: true,
      },
    };
  }

  readonly deleteMemory = Effect.fn('SettingsMemoryController.deleteMemory')(
    function* (
      this: SettingsMemoryController,
      input: { storagePath: string; displayPath: string },
    ) {
      const confirmed = yield* Effect.tryPromise({
        try: () =>
          this.deps.prompt.confirm(`Delete "${input.displayPath}"?`, {
            modal: true,
            confirmLabel: 'Delete',
          }),
        catch: (cause) => new MemoryPromptFailed({ cause }),
      });
      if (!confirmed) return null;

      const storagePath = resolveMemoryStoragePath(input.storagePath);
      yield* Effect.tryPromise({
        try: () => StorageFS.delete(storagePath, { recursive: true }),
        catch: (cause) => new MemoryFileUnwritable({ storagePath, cause }),
      });
      return yield* this.getMemoryDataMessage();
    },
  );

  readonly setMemoryPinned = Effect.fn(
    'SettingsMemoryController.setMemoryPinned',
  )(function* (
    this: SettingsMemoryController,
    storagePath: string,
    pinned: boolean,
  ) {
    const resolvedPath = resolveMemoryStoragePath(storagePath);
    const result = yield* setMemoryPinned(resolvedPath, pinned);
    if (result.status === 'cap-reached') {
      yield* Effect.tryPromise({
        try: () =>
          this.deps.prompt.warning(
            `Cannot pin: maximum of ${MAX_PINNED_MEMORIES} pinned memories reached. Unpin an existing memory first.`,
          ),
        catch: (cause) => new MemoryPromptFailed({ cause }),
      });
      return null;
    }
    return yield* this.getMemoryDataMessage();
  });
}
