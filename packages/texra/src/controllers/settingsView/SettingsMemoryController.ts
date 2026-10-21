import { Effect } from 'effect';

import { MemoryStore } from '@texra-ai/harness/plugins';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { PromptHost } from '@texra/hosts/uiHosts';
import type { MemoryPreview } from '@texra/shared/settingsView/settingsViewMessages';
import type { MemoryViewItem } from '@texra-ai/harness/schemas';

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
    const items = yield* MemoryStore.list;
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
      items,
    } satisfies SettingsMemoryMessage;
  });

  readonly getMemoryPreviewMessage = Effect.fn(
    'SettingsMemoryController.getMemoryPreviewMessage',
  )(function* (storagePath: string) {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: yield* MemoryStore.preview(storagePath),
    } satisfies SettingsMemoryMessage;
  });

  getMemoryPreviewErrorMessage(storagePath: string): SettingsMemoryMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
      preview: { storagePath, error: true },
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

      // On the memory tree's lane, as every memory tool command is: a delete
      // from here never races an agent's edit beneath it.
      yield* MemoryStore.delete(input.storagePath);
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
    const result = yield* MemoryStore.pin(storagePath, pinned);
    if (result.status === 'cap-reached') {
      yield* this.deps.prompt.warning(
        `Cannot pin: maximum of ${result.max} pinned memories reached. Unpin an existing memory first.`,
      );
      return null;
    }
    return yield* this.getMemoryDataMessage();
  });
}
