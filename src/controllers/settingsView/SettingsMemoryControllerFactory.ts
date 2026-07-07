/**
 * Concrete settings-memory controller composition shared by extension and
 * desktop hosts.
 *
 * The controller remains dependency-injected for tests; this factory owns the
 * production memory storage/format wiring so `src/shared/settingsView` stays
 * free of tool-layer implementation imports.
 */

import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';

// Local imports - shared state
import { GlobalStateKey } from '@shared/state/stateKeys';

// Local imports - memory tooling
import {
  loadMemoryItems,
  loadMemoryPreview,
} from '@tools/memory/memoryFileSystem';
import { MAX_PINNED_MEMORIES } from '@tools/memory/constants';
import {
  buildFile,
  countPinnedMemories,
  parseFrontmatter,
  setPinnedMeta,
} from '@tools/memory/memoryMeta';

// Local imports - file system
import { StorageFS } from '@utils/files';

// Local imports - controller
import { SettingsMemoryController } from './SettingsMemoryController';

// Type-only imports
import type { StateStore } from '@platform/interfaces';

type ConstructorArgs = ConstructorParameters<
  typeof SettingsMemoryController
>[0];

export interface SettingsMemoryControllerFactoryOptions {
  readonly globalState: StateStore;
  readonly prompt: ConstructorArgs['prompt'];
  /** Optional override for persisting the memory-enabled flag. */
  readonly setMemoryEnabled?: ConstructorArgs['setMemoryEnabled'];
}

export function createSettingsMemoryController(
  options: SettingsMemoryControllerFactoryOptions,
): SettingsMemoryController {
  const { globalState } = options;
  return new SettingsMemoryController({
    prompt: options.prompt,
    loadMemoryItems,
    loadMemoryPreview,
    isMemoryEnabled: () =>
      globalState.get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
    setMemoryEnabled:
      options.setMemoryEnabled ??
      (async (enabled) => {
        await globalState.update(GlobalStateKey.MEMORY_ENABLED, enabled);
      }),
    memoryStoragePath: resolveMemoryStoragePath,
    storage: StorageFS,
    maxPinnedMemories: MAX_PINNED_MEMORIES,
    parseMemoryFile: parseFrontmatter,
    buildMemoryFile: buildFile,
    setPinnedMeta,
    countPinnedMemories,
  });
}
