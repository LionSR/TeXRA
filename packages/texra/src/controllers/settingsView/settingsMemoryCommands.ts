/**
 * The Memory page of the settings body: list, preview, open, delete and pin
 * the memories in this session's storage.
 */
import { Effect } from 'effect';

import { MemoryStore, StorageFs } from '@texra-ai/harness/plugins';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import type { ProcessServices } from '@texra-ai/harness/host';

import {
  hostStatePage,
  type SettingsHostBindings,
  type SettingsPresentation,
} from './settingsHostBindings';

/** The Memory page: its arms and its page. */
export function settingsMemoryCommands(ports: {
  readonly bindings: Pick<
    SettingsHostBindings,
    'post' | 'dialogs' | 'openPath' | 'revealPath'
  >;
  readonly present: Pick<
    SettingsPresentation,
    'report' | 'reported' | 'changed'
  >;
}) {
  const { bindings } = ports;
  const { report, reported, changed } = ports.present;
  const memoryChanged = changed('memory');
  const page = hostStatePage(
    'memory',
    ['memory'],
    Effect.map(MemoryStore.list, (items) => ({ items })),
  );
  const setMemoryPinned = Effect.fn('setMemoryPinned')(function* (
    storagePath: string,
    pinned: boolean,
  ) {
    const result = yield* MemoryStore.pin(storagePath, pinned);
    if (result.status === 'cap-reached') {
      yield* bindings.dialogs.notify(
        'warning',
        `Cannot pin: maximum of ${result.max} pinned memories reached. Unpin an existing memory first.`,
      );
      return;
    }
    yield* memoryChanged;
  });

  const handlers = {
    getMemoryData: () => memoryChanged,
    // Every outcome of the read-and-post is answered: a failure is reported
    // and then the preview's placeholder is posted, so the view never waits
    // on a preview that will not arrive.
    getMemoryPreview: ({ storagePath }) =>
      bindings
        .post(
          Effect.map(MemoryStore.preview(storagePath), (preview) => ({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
            preview,
          })),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.andThen(
              report('Failed to load memory preview', error),
              bindings.post(
                Effect.succeed({
                  command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
                  preview: { storagePath, error: true },
                }),
              ),
            ),
          ),
        ),
    openMemoryFile: ({ storagePath }) =>
      reported(
        'Failed to open memory file',
        Effect.flatMap(
          Effect.flatMap(MemoryStore.storagePath(storagePath), (path) =>
            StorageFs.use((storage) => storage.resolve(path)),
          ),
          bindings.openPath,
        ),
      ),
    openMemoryFolder: () => {
      const folder = MemoryStore.folder;
      return reported(
        'Failed to open memory folder',
        Effect.flatMap(
          StorageFs.use((storage) =>
            Effect.andThen(
              storage.makeDirectory(folder, { recursive: true }),
              storage.resolve(folder),
            ),
          ),
          bindings.revealPath,
        ),
      );
    },
    deleteMemory: Effect.fn('deleteMemory')(
      function* ({ storagePath, displayPath }) {
        // A declined delete changes nothing. A prompt that cannot show and a
        // failed remove stay typed, so the failure is reported and the list
        // the view is waiting on is read again.
        const confirmed = yield* bindings.dialogs.confirm({
          message: `Delete "${displayPath}"?`,
          action: 'Delete',
        });
        if (!confirmed) return;
        // On the memory tree's lane, as every memory tool command is: a delete
        // from here never races an agent's edit beneath it.
        yield* MemoryStore.delete(storagePath);
        yield* memoryChanged;
      },
      Effect.catch((error) =>
        Effect.andThen(report('Failed to delete memory', error), memoryChanged),
      ),
    ),
    pinMemory: ({ storagePath }) =>
      reported('Failed to pin memory', setMemoryPinned(storagePath, true)),
    unpinMemory: ({ storagePath }) =>
      reported('Failed to unpin memory', setMemoryPinned(storagePath, false)),
  } satisfies Partial<
    SettingsViewInboundHandlerRegistry<ProcessServices | StorageFs>
  >;
  return { handlers, page };
}
