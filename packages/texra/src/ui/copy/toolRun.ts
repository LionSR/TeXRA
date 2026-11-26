/**
 * The words of the conversation's two summary lines: a stretch of tool
 * calls read as one sentence, and a finished turn's work.
 */
import { formatCompactDuration, pluralize } from '@texra-ai/worldline/schemas';

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
  read: (n) => `read ${n} ${pluralize(n, 'file')}`,
  edit: (n) => `edited ${n} ${pluralize(n, 'file')}`,
  write: (n) => `wrote ${n} ${pluralize(n, 'file')}`,
  search: (n) => `searched ${n} ${pluralize(n, 'time')}`,
  bash: (n) => `ran ${n} ${pluralize(n, 'command')}`,
  web: (n) => `searched the web ${n} ${pluralize(n, 'time')}`,
  agent: (n) => `started ${n} ${pluralize(n, 'agent')}`,
  script: (n) => `ran ${n} ${pluralize(n, 'script')}`,
  other: (n) => `used ${n} ${pluralize(n, 'tool')}`,
};

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/** "Read 3 files, searched 2 times and edited 1 file". */
export function toolRunSentence(counts: ToolRunCounts): string {
  const sentence = LIST.format(
    counts.map(([clause, count]) => CLAUSE[clause](count)),
  );
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** A run's failed calls, beside its sentence. */
export const toolRunFailed = (count: number): string => `${count} failed`;

/** The line a finished turn's work stands behind. */
export const workedFor = (durationMs: number): string =>
  `Worked for ${formatCompactDuration(durationMs)}`;
