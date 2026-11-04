import { Predicate } from 'effect';

/** What happens when a candidate's model cannot run: refuse, run the next
 *  one with a notice, or run it silently. */
export type RunModelFallbackMode = 'reject' | 'notice' | 'silent';

/** Where a run's model may come from, highest precedence first, and what
 *  happens when that candidate cannot run: a model a person named, or a
 *  credential chose, is refused; a configured or remembered one falls back
 *  with a notice; a default falls back silently. The one table of both. */
const RUN_MODEL_REASONS = {
  'explicit-override': { rank: 0, fallback: 'reject' },
  environment: { rank: 1, fallback: 'reject' },
  'agent-config': { rank: 2, fallback: 'notice' },
  'command-config': { rank: 3, fallback: 'notice' },
  'workspace-config': { rank: 4, fallback: 'notice' },
  'user-config': { rank: 5, fallback: 'notice' },
  history: { rank: 6, fallback: 'notice' },
  'parent-run': { rank: 7, fallback: 'notice' },
  credential: { rank: 8, fallback: 'reject' },
  'builtin-default': { rank: 9, fallback: 'silent' },
  'access-list-default': { rank: 10, fallback: 'silent' },
} as const satisfies Record<
  string,
  { readonly rank: number; readonly fallback: RunModelFallbackMode }
>;

export type RunModelDecisionReason = keyof typeof RUN_MODEL_REASONS;

export interface RunModelCandidate {
  readonly model?: string | null;
  readonly reason: RunModelDecisionReason;
}

type NormalizedRunModelCandidate = RunModelCandidate & {
  readonly model: string;
};

/** The model a run takes, why, and the candidate it fell back from. */
export interface RunModelDecision {
  readonly model: string;
  readonly reason: RunModelDecisionReason;
  readonly unavailable?: true;
  readonly fallbackFrom?: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
    readonly mode: RunModelFallbackMode;
  };
}

function normalizeCandidate(
  candidate: RunModelCandidate,
): NormalizedRunModelCandidate | null {
  const model = candidate.model?.trim();
  return model ? { ...candidate, model } : null;
}

export function decideRunModel(
  candidates: readonly RunModelCandidate[],
  isRunnable: (model: string) => boolean = () => true,
): RunModelDecision | null {
  const ordered = candidates
    .map(normalizeCandidate)
    .filter(Predicate.isNotNullish)
    .toSorted(
      (left, right) =>
        RUN_MODEL_REASONS[left.reason].rank -
        RUN_MODEL_REASONS[right.reason].rank,
    );
  const fallback = ordered.find(
    (candidate) =>
      candidate.reason === 'access-list-default' && isRunnable(candidate.model),
  );
  // The highest-precedence candidate that is not the access-list default
  // decides alone; the access-list default is only ever the fallback.
  const primary = ordered.find(
    (candidate) => candidate.reason !== 'access-list-default',
  );
  if (!primary) {
    return fallback ? { model: fallback.model, reason: fallback.reason } : null;
  }
  if (isRunnable(primary.model)) {
    return { model: primary.model, reason: primary.reason };
  }
  const mode = RUN_MODEL_REASONS[primary.reason].fallback;
  if (mode === 'reject' || !fallback) {
    return {
      model: primary.model,
      reason: primary.reason,
      unavailable: true,
    };
  }
  return {
    model: fallback.model,
    reason: fallback.reason,
    fallbackFrom: { model: primary.model, reason: primary.reason, mode },
  };
}
