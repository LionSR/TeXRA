import type { CliHistoryEntry } from './history';

function formatCliHistoryInputLabel(inputBasename: string): string {
  return inputBasename === '-' ? 'no input' : inputBasename;
}

export function formatCliHistoryResumeInputLabel(
  entry: Pick<CliHistoryEntry, 'description' | 'inputBasename'>,
): string {
  if (entry.inputBasename !== '-') {
    return formatCliHistoryInputLabel(entry.inputBasename);
  }
  return entry.description?.trim() || 'no input';
}
