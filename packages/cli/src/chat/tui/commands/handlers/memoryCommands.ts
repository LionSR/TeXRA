import {
  formatCliMemoryList,
  formatCliMemoryPreview,
} from '@cli/runtime/memory';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

export async function showCliMemoryList(): Promise<void> {
  appendLocalAssistantTranscript(formatCliMemoryList(await loadMemoryItems()));
}

export async function showCliMemoryPreview(inputPath: string): Promise<void> {
  appendLocalAssistantTranscript(await formatCliMemoryPreview(inputPath));
}
