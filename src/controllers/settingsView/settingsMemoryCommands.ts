/**
 * The Memory page of the settings body: list, preview, open, delete and pin
 * the memories in this session's storage.
 */
import { Effect } from 'effect';

import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import type { ProcessServices } from '@platform/processRuntime';
import { StorageFs } from '@platform/rootedFs';

import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

/** The Memory page: its arms and its opening data. */
export function settingsMemoryCommands(ports: {
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
}) {
  const { bindings } = ports;
  const { report, reported } = ports.present;
  const memory = new SettingsMemoryController({ prompt: bindings.prompt });
  const postMemoryData = bindings.post(memory.getMemoryDataMessage());
  // The controller answers a mutation the user declined (a cancelled
  // delete, a pin over the cap) with `null` after prompting.
  const postMemoryMutation = (
    mutation: Effect.Effect<unknown, never, StorageFs>,
  ) =>
    Effect.flatMap(mutation, (message) =>
      message == null ? Effect.void : bindings.post(Effect.succeed(message)),
    );

  const handlers = {
    getMemoryData: () => postMemoryData,
    // Every outcome of the read-and-post is answered: a failure is reported
    // and then the preview's placeholder is posted, so the view never waits
    // on a preview that will not arrive.
    getMemoryPreview: ({ storagePath }) =>
      bindings
        .post(memory.getMemoryPreviewMessage(storagePath))
        .pipe(
          Effect.catch((error) =>
            Effect.andThen(
              report('Failed to load memory preview', error),
              bindings.post(
                Effect.sync(() =>
                  memory.getMemoryPreviewErrorMessage(storagePath),
                ),
              ),
            ),
          ),
        ),
    openMemoryFile: ({ storagePath }) =>
      reported(
        'Failed to open memory file',
        Effect.flatMap(
          StorageFs.use((storage) =>
            storage.resolve(resolveMemoryStoragePath(storagePath)),
          ),
          bindings.openPath,
        ),
      ),
    openMemoryFolder: () => {
      const folder = resolveMemoryStoragePath();
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
    deleteMemory: (message) =>
      postMemoryMutation(memory.deleteMemory(message)).pipe(
        Effect.catch((error) =>
          Effect.andThen(
            report('Failed to delete memory', error),
            postMemoryData,
          ),
        ),
      ),
    pinMemory: ({ storagePath }) =>
      reported(
        'Failed to pin memory',
        postMemoryMutation(memory.setMemoryPinned(storagePath, true)),
      ),
    unpinMemory: ({ storagePath }) =>
      reported(
        'Failed to unpin memory',
        postMemoryMutation(memory.setMemoryPinned(storagePath, false)),
      ),
  } satisfies Partial<
    SettingsViewInboundHandlerRegistry<ProcessServices | StorageFs>
  >;
  return { handlers, postMemoryData };
}
