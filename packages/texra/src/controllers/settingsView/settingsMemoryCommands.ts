/**
 * The Memory page of the settings body: list, preview, open, delete and pin
 * the memories in this session's storage.
 */
import { Effect } from 'effect';

import { StorageFs } from '@texra-ai/harness';
import { MemoryStore } from '@texra-ai/harness/plugins';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import type { ProcessServices } from '@texra-ai/harness';

import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

/** The Memory page: its arms and its opening data. */
export function settingsMemoryCommands(ports: {
  readonly bindings: Pick<
    SettingsHostBindings,
    'post' | 'prompt' | 'openPath' | 'revealPath'
  >;
  readonly present: Pick<SettingsPresentation, 'report' | 'reported'>;
}) {
  const { bindings } = ports;
  const { report, reported } = ports.present;
  const memoryData = Effect.map(MemoryStore.list, (items) => ({
    command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
    items,
  }));
  const postMemoryData = bindings.post(memoryData);
  // A mutation reads the refreshed list whether or not a view is open, so a
  // failed read after a delete or pin is reported either way.
  const postMutatedMemoryData = Effect.flatMap(memoryData, (message) =>
    bindings.post(Effect.succeed(message)),
  );
  const setMemoryPinned = (storagePath: string, pinned: boolean) =>
    Effect.gen(function* () {
      const result = yield* MemoryStore.pin(storagePath, pinned);
      if (result.status === 'cap-reached') {
        yield* bindings.prompt.warning(
          `Cannot pin: maximum of ${result.max} pinned memories reached. Unpin an existing memory first.`,
        );
        return;
      }
      yield* postMutatedMemoryData;
    });

  const handlers = {
    getMemoryData: () => postMemoryData,
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
    deleteMemory: ({ storagePath, displayPath }) =>
      Effect.gen(function* () {
        // A declined delete posts nothing. A prompt that cannot show and a
        // failed remove stay typed, so the failure is reported and the list
        // the view is waiting on is reposted.
        const confirmed = yield* bindings.prompt.confirm(
          `Delete "${displayPath}"?`,
          { modal: true, confirmLabel: 'Delete' },
        );
        if (!confirmed) return;
        // On the memory tree's lane, as every memory tool command is: a delete
        // from here never races an agent's edit beneath it.
        yield* MemoryStore.delete(storagePath);
        yield* postMutatedMemoryData;
      }).pipe(
        Effect.catch((error) =>
          Effect.andThen(
            report('Failed to delete memory', error),
            postMemoryData,
          ),
        ),
      ),
    pinMemory: ({ storagePath }) =>
      reported('Failed to pin memory', setMemoryPinned(storagePath, true)),
    unpinMemory: ({ storagePath }) =>
      reported('Failed to unpin memory', setMemoryPinned(storagePath, false)),
  } satisfies Partial<
    SettingsViewInboundHandlerRegistry<ProcessServices | StorageFs>
  >;
  return { handlers, postMemoryData };
}
