import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import { USER_VAR_MODEL } from '@agent/prompt/userVars';
import { isNonEmptyString } from '@utils/core';

import type { ToolUseRunShared } from './nodes/types';

export function currentModelFromUserChannels(
  channels: UserVariableChannels,
): string | undefined {
  const value =
    channels.transient[USER_VAR_MODEL] ?? channels.input[USER_VAR_MODEL];
  return isNonEmptyString(value) ? value.trim() : undefined;
}

/**
 * Record a model switch in persisted shared state: `modelId` is the resume
 * SSOT. The `MODEL` user variable is re-projected alongside it so the
 * pre-`modelId` reader in {@link currentModelFromUserChannels} agrees with it
 * on records this run rewrites; prompts read the live model off the run's
 * `ModelCell`, not from here.
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
