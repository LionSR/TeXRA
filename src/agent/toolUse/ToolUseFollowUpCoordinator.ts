// Local imports - coordination
import { ToolUseSessionCoordinator } from './ToolUseSessionCoordinator';
import type {
  ResumeAgentResult,
  ToolUseSessionSnapshot,
} from './ToolUseSessionPersistence';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  await ToolUseSessionCoordinator.handleFollowUp(streamId, text);
}

export async function resumeFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<ResumeAgentResult> {
  return ToolUseSessionCoordinator.resumeFromSnapshot(snapshot, followUp);
}

export type { ResumeAgentResult } from './ToolUseSessionPersistence';
