import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
  runCliMemory,
} from '@cli/runtime/memory';
import { openInfoPane } from '@cli/chat/tui/state/cliState';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

/** The roots the chat surface holds, which its memory reads run over. */
type MemoryRoots = Pick<
  WorkspaceRoots,
  'workspace' | 'storage' | 'globalStorage'
>;

export async function showCliMemoryList(
  runtime: ProcessRuntime,
  roots: MemoryRoots,
): Promise<void> {
  openInfoPane(
    '/memory list',
    formatCliMemoryList(
      await runtime.runPromise(runCliMemory(roots, loadMemoryItems())),
    ),
  );
}

export async function showCliMemoryPreview(
  runtime: ProcessRuntime,
  roots: MemoryRoots,
  inputPath: string,
): Promise<void> {
  openInfoPane(
    '/memory preview',
    formatCliMemoryPreview(
      await runtime.runPromise(
        runCliMemory(roots, loadCliMemoryDetail(inputPath)),
      ),
    ),
  );
}
