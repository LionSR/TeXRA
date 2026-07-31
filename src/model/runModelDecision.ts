import { filterNotNullish } from '@utils/core';

const RUN_MODEL_PRECEDENCE = {
  'explicit-override': 0,
  environment: 1,
  'agent-config': 2,
  'command-config': 3,
  'workspace-config': 4,
  'user-config': 5,
  history: 6,
  'parent-run': 7,
  'router-config': 8,
  credential: 9,
  'builtin-default': 10,
  'access-list-default': 11,
} as const;

export type RunModelDecisionReason = keyof typeof RUN_MODEL_PRECEDENCE;
type RunModelFallbackMode = 'reject' | 'notice' | 'silent';

export interface RunModelCandidate {
  readonly model?: string | null;
  readonly reason: RunModelDecisionReason;
  readonly fallbackMode?: RunModelFallbackMode;
}

type NormalizedRunModelCandidate = RunModelCandidate & {
  readonly model: string;
};

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
    .filter(filterNotNullish)
    .toSorted(
      (left, right) =>
        RUN_MODEL_PRECEDENCE[left.reason] - RUN_MODEL_PRECEDENCE[right.reason],
    );
  const fallback = ordered.find(
    (candidate) =>
      candidate.reason === 'access-list-default' && isRunnable(candidate.model),
  );

  for (const candidate of ordered) {
    if (candidate.reason === 'access-list-default') continue;
    if (isRunnable(candidate.model)) {
      return { model: candidate.model, reason: candidate.reason };
    }
    const mode = candidate.fallbackMode ?? 'reject';
    if (mode === 'reject' || !fallback) {
      return {
        model: candidate.model,
        reason: candidate.reason,
        unavailable: true,
      };
    }
    return {
      model: fallback.model,
      reason: fallback.reason,
      fallbackFrom: { model: candidate.model, reason: candidate.reason, mode },
    };
  }

  return fallback ? { model: fallback.model, reason: fallback.reason } : null;
}
