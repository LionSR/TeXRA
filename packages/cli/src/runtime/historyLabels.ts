import type { CliHistoryEntry } from './history';

/**
 * What a history entry is about: its first input file, or, for runs started
 * without one, the session description collapsed to a single line. Both
 * callers render this inside one line of output, so the collapse is not
 * optional.
 */
export function formatCliHistorySubject(
  entry: Pick<CliHistoryEntry, 'description' | 'inputBasename'>,
  noInputLabel: string,
): string {
  if (entry.inputBasename !== '-') return entry.inputBasename;
  return entry.description?.replaceAll(/\s+/g, ' ').trim() || noInputLabel;
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
  return `${formatCliHistoryAgentLabel(entry)}; ${entry.status}; ${formatCliHistorySubject(entry, 'no input')}`;
}
