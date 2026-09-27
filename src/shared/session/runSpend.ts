/**
 * A run's spend as the session fold derives it. The spend is stored once
 * per priced turn (a `model.message` response, projected as a `usage` row
 * by the database's display reads, or an agent-CLI child's own `usage`
 * row), so the run's total and a workflow transcript's statistics row are
 * sums of turns, never a running total some writer restated.
 */
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  AgentCategory,
  runStatistics,
  sumUsageStats,
  type DisplaySessionEvent,
  type ExtendedTokenUsageStats,
  type RunId,
  type TurnUsage,
} from '@shared/schemas';

import type { RunView } from './sessionView';

type UsageEvent = Extract<DisplaySessionEvent, { type: 'usage' }>;

/** Each run's priced turns by seq: a row the listing and an aggregate
 *  replay both deliver counts once. */
export type RunTurns = Map<RunId, Map<number, TurnUsage>>;

/** The run with one more priced turn in its total. */
export function withTurn(
  turns: RunTurns,
  run: RunView,
  event: UsageEvent,
): RunView {
  const known = turns.get(run.id) ?? new Map<number, TurnUsage>();
  known.set(event.seq, event.usage);
  turns.set(run.id, known);
  return { ...run, usage: sumUsageStats(known.values()) };
}

/**
 * What a row's transcript fold needs of the run's spend: after a workflow
 * run's priced turn, the totals of its turns up to this one for the model the
 * run is on, which its transcript shows as a statistics row. Nothing for any
 * other row or run.
 */
export function statisticsContext(
  turns: RunTurns,
  run: RunView,
  event: DisplaySessionEvent,
): { readonly statistics?: ExtendedTokenUsageStats } {
  if (event.type !== 'usage' || run.category !== AgentCategory.Workflow) {
    return {};
  }
  const earlier = [...(turns.get(run.id) ?? [])]
    .filter(([seq]) => seq < event.seq)
    .sort(([a], [b]) => a - b)
    .map(([, turn]) => turn);
  const model = run.model === null ? undefined : MODEL_CONFIGS[run.model];
  return {
    statistics: runStatistics([...earlier, event.usage], model?.capabilities),
  };
}
