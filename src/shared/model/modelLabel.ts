/** Browser-safe presentation helpers for persisted model identifiers. */

// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

/** Resolve a persisted model id to its static user-facing catalogue label. */
export function getModelLabel(model: string): string {
  return MODEL_CONFIGS[model]?.label ?? model;
}
