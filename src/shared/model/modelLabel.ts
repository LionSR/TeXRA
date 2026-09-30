/** Browser-safe presentation helpers for persisted model identifiers. */

// Third-party imports
import { modelConfig } from '@shared/model/modelSelection';

/** Resolve a persisted model id to its static user-facing catalogue label. */
export function getModelLabel(model: string): string {
  return modelConfig(model)?.label ?? model;
}
