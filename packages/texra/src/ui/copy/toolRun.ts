/**
 * The words of the conversation's two summary lines: a stretch of tool
 * calls read as one sentence, and a finished turn's work.
 */
// Third-party imports
import { String as Str } from 'effect';

// Local imports
import {
  formatCompactDuration,
  formatResultCount,
} from '@texra-ai/worldline/schemas';

/** What a call counts as in a run's sentence. */
export type ToolRunClause =
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'bash'
  | 'web'
  | 'agent'
  | 'script'
  | 'other';

/** A run's calls by clause, in first-use order. */
export type ToolRunCounts = readonly (readonly [ToolRunClause, number])[];

const CLAUSE: Readonly<Record<ToolRunClause, (count: number) => string>> = {
  read: (n) => `read ${formatResultCount(n, 'file')}`,
  edit: (n) => `edited ${formatResultCount(n, 'file')}`,
  write: (n) => `wrote ${formatResultCount(n, 'file')}`,
  search: (n) => `searched ${formatResultCount(n, 'time')}`,
  bash: (n) => `ran ${formatResultCount(n, 'command')}`,
  web: (n) => `searched the web ${formatResultCount(n, 'time')}`,
  agent: (n) => `started ${formatResultCount(n, 'agent')}`,
  script: (n) => `ran ${formatResultCount(n, 'script')}`,
  other: (n) => `used ${formatResultCount(n, 'tool')}`,
};

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/** "Read 3 files, searched 2 times and edited 1 file". */
export function toolRunSentence(counts: ToolRunCounts): string {
  return Str.capitalize(
    LIST.format(counts.map(([clause, count]) => CLAUSE[clause](count))),
  );
}

/** A run's failed calls, beside its sentence. */
export const toolRunFailed = (count: number): string => `${count} failed`;

/** The line a finished turn's work stands behind. */
export const workedFor = (durationMs: number): string =>
  `Worked for ${formatCompactDuration(durationMs)}`;
