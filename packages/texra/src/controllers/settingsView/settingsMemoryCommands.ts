/**
 * The Memory page of the settings body: open one of the session's memory
 * folders, made first if no note was ever written to it.
 */
import { Effect, FileSystem } from 'effect';

import { memoryFolders } from '@texra-ai/harness/plugins';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ProcessServices } from '@texra-ai/harness/host';

import type {
  SettingsHostBindings,
  SettingsPresentation,
  SettingsViewInboundHandlerRegistry,
} from './settingsHostBindings';

/** The Memory page's handlers. */
export function settingsMemoryCommands(ports: {
  readonly roots: WorkspaceRoots;
  readonly bindings: Pick<SettingsHostBindings, 'revealPath'>;
  readonly present: Pick<SettingsPresentation, 'reported'>;
}) {
  const [user, project] = memoryFolders(ports.roots);
  return {
    openMemoryFolder: ({ folder }) => {
      const { path } = folder === 'user' ? user : project;
      return ports.present.reported(
        'Failed to open memory folder',
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.andThen(
            fs.makeDirectory(path, { recursive: true }),
            ports.bindings.revealPath(path),
          ),
        ),
      );
    },
  } satisfies Partial<SettingsViewInboundHandlerRegistry<ProcessServices>>;
}
