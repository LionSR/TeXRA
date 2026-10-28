import { Effect, type FileSystem, type Path } from 'effect';

import { withSessionFs } from '@texra-ai/harness';
import { MemoryStore } from '@texra-ai/harness/plugins';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
} from '@cli/runtime/memory';
import { openInfoPane } from '@cli/chat/tui/state/cliState';
import type { WorkspaceRoots } from '@texra-ai/harness';

/** The roots the chat surface holds, which its memory reads run over. */
type MemoryRoots = Pick<
  WorkspaceRoots,
  'workspace' | 'storage' | 'globalStorage'
>;

export const showCliMemoryList = (
  roots: MemoryRoots,
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =>
  withSessionFs(roots, MemoryStore.list).pipe(
    Effect.map((items) => {
      openInfoPane('/memory list', formatCliMemoryList(items));
    }),
  );

export const showCliMemoryPreview = (
  roots: MemoryRoots,
  inputPath: string,
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =>
  withSessionFs(roots, loadCliMemoryDetail(inputPath)).pipe(
    Effect.map((detail) => {
      openInfoPane('/memory preview', formatCliMemoryPreview(detail));
    }),
  );
