import { Data, Predicate } from 'effect';

/** Where a run's model may come from, highest precedence first, and what
 *  happens when that candidate cannot run: a model a person named is
 *  refused; a configured or remembered one falls back with a notice; a
 *  default falls back silently. The one table of both. */
const RUN_MODEL_REASONS = {
  'explicit-override': { rank: 0, fallback: 'reject' },
  environment: { rank: 1, fallback: 'reject' },
  'agent-config': { rank: 2, fallback: 'notice' },
  'command-config': { rank: 3, fallback: 'notice' },
  history: { rank: 4, fallback: 'notice' },
  'parent-run': { rank: 5, fallback: 'notice' },
  'builtin-default': { rank: 6, fallback: 'silent' },
  'access-list-default': { rank: 7, fallback: 'silent' },
} as const satisfies Record<
  string,
  { readonly rank: number; readonly fallback: 'reject' | 'notice' | 'silent' }
>;

export type RunModelDecisionReason = keyof typeof RUN_MODEL_REASONS;

export interface RunModelCandidate {
  readonly model?: string | null;
  readonly reason: RunModelDecisionReason;
}

type NormalizedRunModelCandidate = RunModelCandidate & {
  readonly model: string;
};

/**
 * The model a run takes and why. `Fallback` runs another model than the one
 * its candidate named and carries the sentence that tells the person;
 * `Unavailable` names the candidate that cannot run and has nothing to fall
 * back to. A caller matches every case.
 */
export type RunModelDecision = Data.TaggedEnum<{
  Chosen: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
  };
  Fallback: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
    readonly from: {
      readonly model: string;
      readonly reason: RunModelDecisionReason;
    };
    readonly notice: string;
  };
  Unavailable: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
  };
}>;

const { Chosen, Fallback, Unavailable } = Data.taggedEnum<RunModelDecision>();

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
    return fallback
      ? Chosen({ model: fallback.model, reason: fallback.reason })
      : null;
  }
  if (isRunnable(primary.model)) {
    return Chosen({ model: primary.model, reason: primary.reason });
  }
  const mode = RUN_MODEL_REASONS[primary.reason].fallback;
  if (mode === 'reject' || !fallback) {
    return Unavailable({ model: primary.model, reason: primary.reason });
  }
  if (mode === 'silent') {
    return Chosen({ model: fallback.model, reason: fallback.reason });
  }
  return Fallback({
    model: fallback.model,
    reason: fallback.reason,
    from: { model: primary.model, reason: primary.reason },
    notice: `Model "${primary.model}" is not available. Using "${fallback.model}" instead.`,
  });
}
