import type { CliHistoryEntry } from './history';

function formatCliHistoryResumeInputLabel(
  entry: Pick<CliHistoryEntry, 'description' | 'inputBasename'>,
): string {
  if (entry.inputBasename !== '-') return entry.inputBasename;
  return entry.description?.trim() || 'no input';
}

export function formatCliHistoryAgentLabel(
  entry: Pick<CliHistoryEntry, 'agent' | 'teamPresetId'>,
): string {
  return entry.teamPresetId ? `team:${entry.teamPresetId}` : entry.agent;
}

export function formatCliHistoryResumeSummary(
  entry: Pick<
    CliHistoryEntry,
    'agent' | 'description' | 'inputBasename' | 'status' | 'teamPresetId'
  >,
): string {
  return `${formatCliHistoryAgentLabel(entry)}; ${entry.status}; ${formatCliHistoryResumeInputLabel(entry)}`;
}
