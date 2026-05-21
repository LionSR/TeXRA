/**
 * Shared `SettingsMemoryController` factory.
 *
 * The controller's dependencies fall into two groups: filesystem/format
 * primitives that are platform-agnostic (already wired here), and host-only
 * pieces — the prompt host and the memory-enabled toggle — that callers
 * supply.
 */
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { GlobalStateKey } from '@common/state/stateKeys';
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
import { resolveMemoryStoragePath } from '@tools/memory/memoryUtils';
import { StorageFS } from '@utils/files';

import type { SettingsStatePorts } from './types';

type ConstructorArgs = ConstructorParameters<
  typeof SettingsMemoryController
>[0];

export interface MemoryControllerFactoryOptions extends SettingsStatePorts {
  readonly prompt: ConstructorArgs['prompt'];
  /** Optional override for persisting the memory-enabled flag. */
  readonly setMemoryEnabled?: ConstructorArgs['setMemoryEnabled'];
}

export function createSettingsMemoryController(
  options: MemoryControllerFactoryOptions,
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
    resolveStoragePath: resolveMemoryStoragePath,
    storage: StorageFS,
    maxPinnedMemories: MAX_PINNED_MEMORIES,
    parseMemoryFile: parseFrontmatter,
    buildMemoryFile: buildFile,
    setPinnedMeta,
    countPinnedMemories,
  });
}
