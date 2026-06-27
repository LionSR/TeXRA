import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import type { StreamTabId } from '@shared/schemas';

export type RuntimeFollowUpResult = SendFollowUpResult;

export interface RuntimeFollowUpRequest {
  readonly streamId: StreamTabId;
  readonly text: string;
  readonly mediaFiles?: readonly string[];
  readonly displayText?: string;
  readonly session?: SessionHandle;
}

/** Send a user follow-up to the runtime-owned tool-use session for a stream. */
export function requestRuntimeFollowUp({
  streamId,
  text,
  mediaFiles,
  displayText,
  session,
}: RuntimeFollowUpRequest): Promise<RuntimeFollowUpResult> {
  return sendFollowUp(streamId, text, mediaFiles, displayText, session);
}
