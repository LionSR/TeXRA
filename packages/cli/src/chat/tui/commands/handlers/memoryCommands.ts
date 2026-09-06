import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
  runCliMemory,
} from '@cli/runtime/memory';
import { openInfoPane } from '@cli/chat/tui/state/cliState';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

export async function showCliMemoryList(): Promise<void> {
  openInfoPane(
    '/memory list',
    formatCliMemoryList(await runCliMemory(loadMemoryItems())),
  );
}

export async function showCliMemoryPreview(inputPath: string): Promise<void> {
  openInfoPane(
    '/memory preview',
    formatCliMemoryPreview(await runCliMemory(loadCliMemoryDetail(inputPath))),
  );
}
