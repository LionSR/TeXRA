import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import type { StreamTabId } from '@shared/schemas';

import { currentSession, type SessionHandle } from './SessionHandle';

export type ManualCompactionRequestStatus =
  | 'requested'
  | 'no_session'
  | 'unsupported_model';

export type ManualCompactionRequestResult = {
  readonly status: ManualCompactionRequestStatus;
  readonly message: string;
};

const MANUAL_COMPACTION_MESSAGES: Record<
  ManualCompactionRequestStatus,
  string
> = {
  no_session: 'No active tool-use session found for context compaction.',
  unsupported_model:
    'Manual context compaction is not available for the current model.',
  requested:
    'Context compaction requested. The agent will process it on the next model call.',
};

function manualCompactionResult(
  status: ManualCompactionRequestStatus,
): ManualCompactionRequestResult {
  return {
    status,
    message: MANUAL_COMPACTION_MESSAGES[status],
  };
}

/**
 * Request manual context compaction for a live tool-use stream.
 *
 * This is a runtime command boundary: callers name the stream and receive a
 * small result projection, while flow-context lookup, model capability checks,
 * and follow-up notification remain owned by the agent runtime.
 */
export function requestManualCompaction(
  streamId: StreamTabId | undefined,
  session: SessionHandle = currentSession(),
): ManualCompactionRequestResult {
  if (!streamId) return manualCompactionResult('no_session');

  const flowContext = session.executions.getToolUseFlowContext(streamId);
  if (!flowContext) return manualCompactionResult('no_session');

  if (!flowContext.modelHandler.supportsManualCompaction) {
    return manualCompactionResult('unsupported_model');
  }

  flowContext.requestImmediateCompaction();
  notifyFollowUpSent(streamId, flowContext.runtimeHost);
  return manualCompactionResult('requested');
}
