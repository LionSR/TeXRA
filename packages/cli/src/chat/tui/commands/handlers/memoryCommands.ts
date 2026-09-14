import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
  runCliMemory,
} from '@cli/runtime/memory';
import { openInfoPane } from '@cli/chat/tui/state/cliState';
import type { ProcessRuntime } from '@platform/processRuntime';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

export async function showCliMemoryList(
  runtime: ProcessRuntime,
): Promise<void> {
  openInfoPane(
    '/memory list',
    formatCliMemoryList(await runCliMemory(runtime, loadMemoryItems())),
  );
}

export async function showCliMemoryPreview(
  runtime: ProcessRuntime,
  inputPath: string,
): Promise<void> {
  openInfoPane(
    '/memory preview',
    formatCliMemoryPreview(
      await runCliMemory(runtime, loadCliMemoryDetail(inputPath)),
    ),
  );
}
