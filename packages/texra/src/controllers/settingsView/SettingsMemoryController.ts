import { Effect } from 'effect';

import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { MemoryViewItem } from '@shared/tools/memoryView';
import type { PromptHost } from '@texra/hosts/uiHosts';
import type { MemoryPreview } from '@texra/shared/settingsView/settingsViewMessages';
import { MAX_PINNED_MEMORIES } from '@tools/memory/constants';
import {
  deleteMemoryPath,
  loadMemoryItems,
  loadMemoryPreview,
  onMemoryTreeLane,
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
      // A declined delete is `false`, a value. A prompt that cannot show and
      // a failed remove stay typed, so the Memory page's handler reports the
      // failure and reposts the list the view is waiting on.
      const confirmed = yield* this.deps.prompt.confirm(
        `Delete "${input.displayPath}"?`,
        { modal: true, confirmLabel: 'Delete' },
      );
      if (!confirmed) return null;

      const storagePath = resolveMemoryStoragePath(input.storagePath);
      // On the memory tree's lane, as every memory tool command is: a delete
      // from here never races an agent's edit beneath it.
      yield* deleteMemoryPath(storagePath).pipe(onMemoryTreeLane);
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
    const result = yield* setMemoryPinned(resolvedPath, pinned).pipe(
      onMemoryTreeLane,
    );
    if (result.status === 'cap-reached') {
      yield* this.deps.prompt.warning(
        `Cannot pin: maximum of ${MAX_PINNED_MEMORIES} pinned memories reached. Unpin an existing memory first.`,
      );
      return null;
    }
    return yield* this.getMemoryDataMessage();
  });
}
