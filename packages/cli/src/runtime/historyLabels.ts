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
  entry: Pick<CliHistoryEntry, 'agent' | 'teamId'>,
): string {
  return entry.teamId ? `team:${entry.teamId}` : entry.agent;
}
