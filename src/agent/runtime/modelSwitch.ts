import type { StreamTabId } from '@shared/schemas';

import { currentSession, type SessionHandle } from './SessionHandle';

export interface RuntimeModelSwitchTargetRequest {
  readonly streamId: StreamTabId;
  readonly session?: SessionHandle;
}

export interface RuntimeModelSwitchDisabledReasonRequest extends RuntimeModelSwitchTargetRequest {
  readonly candidateModel: string;
}

export interface RuntimeModelSwitchRequest extends RuntimeModelSwitchTargetRequest {
  readonly model: string;
}

/** Return whether a stream has a live tool-use flow that can receive model commands. */
export function hasRuntimeToolUseModelSwitchTarget({
  streamId,
  session = currentSession(),
}: RuntimeModelSwitchTargetRequest): boolean {
  return session.executions.getToolUseFlowContext(streamId) !== undefined;
}

/** Ask the runtime-owned tool-use flow why a candidate model is unavailable. */
export function getRuntimeModelSwitchDisabledReason({
  streamId,
  candidateModel,
  session = currentSession(),
}: RuntimeModelSwitchDisabledReasonRequest): string | undefined {
  return session.executions
    .getToolUseFlowContext(streamId)
    ?.modelSwitchDisabledReason(candidateModel);
}

/** Request a model switch on the live runtime-owned tool-use flow. */
export async function requestRuntimeModelSwitch({
  streamId,
  model,
  session = currentSession(),
}: RuntimeModelSwitchRequest): Promise<boolean> {
  const flowContext = session.executions.getToolUseFlowContext(streamId);
  if (!flowContext) return false;

  await flowContext.switchModel(model);
  return true;
}
