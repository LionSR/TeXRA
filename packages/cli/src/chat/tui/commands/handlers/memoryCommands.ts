import {
  formatCliMemoryList,
  formatCliMemoryPreview,
} from '@cli/runtime/memory';
import { openInfoPane } from '@cli/chat/tui/state/cliState';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

export async function showCliMemoryList(): Promise<void> {
  openInfoPane('/memory list', formatCliMemoryList(await loadMemoryItems()));
}

export async function showCliMemoryPreview(inputPath: string): Promise<void> {
  openInfoPane('/memory preview', await formatCliMemoryPreview(inputPath));
}
