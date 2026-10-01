import type { BlockedRunListingEntry } from '@agent/storage';
import { HISTORY_RUN_STATUS, runIdentityName } from '@shared/schemas';
import type { CliHistoryEntry } from './history';

/** The row of a run whose record a newer TeXRA wrote: listed, never
 *  resumed here, with what the listing still knows of it. */
export function blockedHistoryEntry(
  entry: BlockedRunListingEntry,
): CliHistoryEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    description: entry.description,
    agent: runIdentityName(entry.identity),
    model: entry.model ?? '-',
    status: HISTORY_RUN_STATUS.BLOCKED,
    resumable: false,
    inputBasename: '-',
  };
}

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

export function formatCliHistoryResumeSummary(
  entry: Pick<
    CliHistoryEntry,
    'agent' | 'description' | 'inputBasename' | 'status' | 'teamId'
  >,
): string {
  return `${formatCliHistoryAgentLabel(entry)}; ${entry.status}; ${formatCliHistorySubject(entry, 'no input')}`;
}
