import { ReasoningEffort } from 'llm-zoo';

/**
 * Display labels for llm-zoo's reasoning efforts, written low → high because
 * the picker offers them in that order. The key type keeps the record
 * exhaustive against the registry vocabulary.
 */
export const REASONING_LEVEL_LABELS: Record<ReasoningEffort, string> = {
  [ReasoningEffort.NONE]: 'None',
  [ReasoningEffort.MINIMAL]: 'Minimal',
  [ReasoningEffort.LOW]: 'Low',
  [ReasoningEffort.MEDIUM]: 'Medium',
  [ReasoningEffort.HIGH]: 'High',
  [ReasoningEffort.XHIGH]: 'Extra High',
  [ReasoningEffort.MAX]: 'Max',
};
export const REASONING_LEVEL_OPTIONS: readonly {
  readonly value: ReasoningEffort;
  readonly label: string;
}[] = Object.entries(REASONING_LEVEL_LABELS).map(([value, label]) => ({
  value: value as ReasoningEffort,
  label,
}));
