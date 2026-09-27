/**
 * A run's spend as the session fold derives it. The spend is stored once
 * per priced turn (a `model.message` response, projected as a `usage` row
 * by the database's display reads, or an agent-CLI child's own `usage`
 * row), so the run's total is a sum of turns, never a running total some
 * writer restated. A workflow transcript's statistics rows are the
 * transcript fold's (`transcriptLogRows.ts`), so a cold read of the run
 * derives them the same way.
 */
import {
  sumUsageStats,
  type DisplaySessionEvent,
  type RunId,
} from '@shared/schemas';

import type { RunView } from './sessionView';

/** Each run's priced turns by seq: a row the listing and an aggregate
 *  replay both deliver counts once. */
export type RunTurns = Map<RunId, Set<number>>;

/** The run with one more priced turn in its running total; a redelivered
 *  turn leaves it as it is. */
export function withTurn(
  turns: RunTurns,
  run: RunView,
  event: Extract<DisplaySessionEvent, { type: 'usage' }>,
): RunView {
  const known = turns.get(run.id) ?? new Set<number>();
  if (known.has(event.seq)) return run;
  known.add(event.seq);
  turns.set(run.id, known);
  return { ...run, usage: sumUsageStats([run.usage, event.usage]) };
}
