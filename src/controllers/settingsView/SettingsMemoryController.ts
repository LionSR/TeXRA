import { Effect } from 'effect';

import type { PromptHost } from '@hosts/uiHosts';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { MemoryPreview, MemoryViewItem } from '@shared/schemas';
import { MAX_PINNED_MEMORIES } from '@tools/memory/constants';
import {
  deleteMemoryPath,
  loadMemoryItems,
  loadMemoryPreview,
  setMemoryPinned,
} from '@tools/memory/memoryFileSystem';

interface SettingsMemoryControllerDeps {
  prompt: Pick<PromptHost, 'confirm' | 'warning'>;
}

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
    const items = yield* Effect.orDie(loadMemoryItems());
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
      items,
    } satisfies SettingsMemoryMessage;
  });

  readonly getMemoryPreviewMessage = Effect.fn(
    'SettingsMemoryController.getMemoryPreviewMessage',
  )(function* (storagePath: string) {
    const resolvedPath = resolveMemoryStoragePath(storagePath);
    const preview = yield* Effect.orDie(loadMemoryPreview(resolvedPath));
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
      // A declined delete is `false`, a value. `PromptFailed` is not matched
      // here for the same reason the memory reads are `orDie`: the memory tab
      // has no recovery for a window that cannot show a dialog, so it reaches
      // the host edge as the host's own fault rather than as a silent no-op.
      const confirmed = yield* Effect.orDie(
        this.deps.prompt.confirm(`Delete "${input.displayPath}"?`, {
          modal: true,
          confirmLabel: 'Delete',
        }),
      );
      if (!confirmed) return null;

      const storagePath = resolveMemoryStoragePath(input.storagePath);
      yield* Effect.orDie(deleteMemoryPath(storagePath));
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
    const result = yield* Effect.orDie(setMemoryPinned(resolvedPath, pinned));
    if (result.status === 'cap-reached') {
      yield* Effect.orDie(
        this.deps.prompt.warning(
          `Cannot pin: maximum of ${MAX_PINNED_MEMORIES} pinned memories reached. Unpin an existing memory first.`,
        ),
      );
      return null;
    }
    return yield* this.getMemoryDataMessage();
  });
}
