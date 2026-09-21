import { Effect, type FileSystem, type Path } from 'effect';

import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
  runCliMemory,
} from '@cli/runtime/memory';
import { openInfoPane } from '@cli/chat/tui/state/cliState';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

/** The roots the chat surface holds, which its memory reads run over. */
type MemoryRoots = Pick<
  WorkspaceRoots,
  'workspace' | 'storage' | 'globalStorage'
>;

export const showCliMemoryList = (
  roots: MemoryRoots,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  runCliMemory(roots, loadMemoryItems()).pipe(
    Effect.map((items) => {
      openInfoPane('/memory list', formatCliMemoryList(items));
    }),
  );

export const showCliMemoryPreview = (
  roots: MemoryRoots,
  inputPath: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  runCliMemory(roots, loadCliMemoryDetail(inputPath)).pipe(
    Effect.map((detail) => {
      openInfoPane('/memory preview', formatCliMemoryPreview(detail));
    }),
  );
