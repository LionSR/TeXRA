import { USER_VAR_MODEL } from '@agent/prompt/userVars';

import type { ToolUseRunShared } from './nodes/types';

/**
 * Record a model switch in persisted shared state. `modelId` is the resume
 * SSOT; `MODEL` remains the prompt-facing user variable for the live run.
 */
export function setToolUseSharedModel(
  shared: ToolUseRunShared,
  model: string,
): boolean {
  if (!shared.stateSlices) return false;
  shared.modelId = model;
  shared.stateSlices = {
    ...shared.stateSlices,
    userChannels: {
      input: shared.stateSlices.userChannels.input,
      transient: {
        ...shared.stateSlices.userChannels.transient,
        [USER_VAR_MODEL]: model,
      },
    },
  };
  return true;
}
