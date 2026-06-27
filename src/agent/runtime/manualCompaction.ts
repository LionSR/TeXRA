import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import type { StreamTabId } from '@shared/schemas';

import { currentSession, type SessionHandle } from './SessionHandle';

export type ManualCompactionRequestResult =
  | { readonly status: 'requested' }
  | { readonly status: 'no_session' }
  | { readonly status: 'unsupported_model' };

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
  if (!streamId) return { status: 'no_session' };

  const flowContext = session.executions.getToolUseFlowContext(streamId);
  if (!flowContext) return { status: 'no_session' };

  if (!flowContext.modelHandler.supportsManualCompaction) {
    return { status: 'unsupported_model' };
  }

  flowContext.requestImmediateCompaction();
  notifyFollowUpSent(streamId, flowContext.runtimeHost);
  return { status: 'requested' };
}
