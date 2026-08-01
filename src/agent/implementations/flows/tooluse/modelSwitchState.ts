import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import { isNonEmptyString } from '@utils/core';

import type { ToolUseRunShared } from './nodes/types';

const MODEL_USER_VARIABLE = 'MODEL';

export function currentModelFromUserChannels(
  channels: UserVariableChannels,
): string | undefined {
  const value =
    channels.transient[MODEL_USER_VARIABLE] ??
    channels.input[MODEL_USER_VARIABLE];
  return isNonEmptyString(value) ? value.trim() : undefined;
}

/**
 * Record a model switch in persisted shared state: `modelId` is the resume
 * SSOT, and the `MODEL` user variable is re-projected from it so prompts keep
 * seeing the model the run is actually on.
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
        [MODEL_USER_VARIABLE]: model,
      },
    },
  };
  return true;
}
