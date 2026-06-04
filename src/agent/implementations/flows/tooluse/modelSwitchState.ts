import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';

import type { ToolUseRunShared } from './nodes/types';

const MODEL_USER_VARIABLE = 'MODEL';

export function currentModelFromUserChannels(
  channels: UserVariableChannels,
): string | undefined {
  const value =
    channels.transient[MODEL_USER_VARIABLE] ??
    channels.input[MODEL_USER_VARIABLE];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function setToolUseSharedModel(
  shared: ToolUseRunShared,
  model: string,
): boolean {
  if (!shared.stateSlices) return false;
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
