import type { StreamTabId } from '@shared/schemas';

import { currentSession, type SessionHandle } from './SessionHandle';

export interface RuntimeModelSwitchTargetRequest {
  readonly streamId: StreamTabId;
  readonly session?: SessionHandle;
}

export interface RuntimeModelSwitchRequest extends RuntimeModelSwitchTargetRequest {
  readonly model: string;
}

export type RuntimeModelSwitchState =
  | {
      readonly status: 'target';
      readonly disabledReason?: string;
    }
  | { readonly status: 'no_target' };

export type RuntimeModelSwitchResult =
  | { readonly status: 'switched' }
  | { readonly status: 'disabled'; readonly reason: string }
  | { readonly status: 'no_target' };

export interface RuntimeModelSwitchStateRequest extends RuntimeModelSwitchTargetRequest {
  readonly candidateModel?: string;
}

/** Return the live model-switch state for a stream without exposing flow handles. */
export function getRuntimeModelSwitchState({
  streamId,
  candidateModel,
  session = currentSession(),
}: RuntimeModelSwitchStateRequest): RuntimeModelSwitchState {
  const flowContext = session.executions.getToolUseFlowContext(streamId);
  if (!flowContext) return { status: 'no_target' };

  const disabledReason =
    candidateModel == null
      ? undefined
      : flowContext.modelSwitchDisabledReason(candidateModel);
  return {
    status: 'target',
    ...(disabledReason != null ? { disabledReason } : {}),
  };
}

/** Request a model switch on the live runtime-owned tool-use flow. */
export async function requestRuntimeModelSwitch({
  streamId,
  model,
  session = currentSession(),
}: RuntimeModelSwitchRequest): Promise<RuntimeModelSwitchResult> {
  const flowContext = session.executions.getToolUseFlowContext(streamId);
  if (!flowContext) return { status: 'no_target' };

  const disabledReason = flowContext.modelSwitchDisabledReason(model);
  if (disabledReason != null) {
    return { status: 'disabled', reason: disabledReason };
  }

  await flowContext.switchModel(model);
  return { status: 'switched' };
}
