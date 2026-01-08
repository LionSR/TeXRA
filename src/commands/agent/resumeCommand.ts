/**
 * Resume agent command - resumes a paused tool-use session.
 *
 * This command is called from the progress view when user clicks Resume.
 * It handles resuming from a snapshot by calling resumeToolUseFromSnapshot.
 */

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { resumeToolUseFromSnapshot } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { logErrorMessage } from '@common/errors/errorHandlingUtils';
import { updateQueuedFollowUpsUI } from '@progressView/utils/updateQueuedFollowUps';
import { getToolUsePersistenceEnabled } from '@utils/config';

// Type imports

// ============================================================================
// Types
// ============================================================================

/** Schema for agent resume operation result. */
export const ResumeAgentResultSchema = z.object({
  success: z.boolean(),
  lostFollowUps: z.number().nonnegative().optional(),
});

/** Result of resuming a tool-use agent from a snapshot. */
export type ResumeAgentResult = z.infer<typeof ResumeAgentResultSchema>;

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
  followUp?: string;
}

// ============================================================================
// Resume Logic
// ============================================================================

const CHANNEL = 'resumeCommand';

function formatLostFollowUpSuffix(count: number): string {
  if (count === 0) {
    return '';
  }
  const label = count === 1 ? 'follow-up was' : 'follow-ups were';
  return ` ${count} queued ${label} lost.`;
}

/**
 * Resume a tool-use session from a snapshot.
 *
 * Handles:
 * - Status transitions (resuming → running → waiting)
 * - Draining queued follow-ups
 * - Error handling with user notification
 */
async function resumeFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<ResumeAgentResult> {
  if (!getToolUsePersistenceEnabled()) {
    return { success: false };
  }

  const streamId = snapshot.streamId as StreamTabId;
  const existingStatus = StreamStatusService.get(streamId);

  if (
    existingStatus === STREAM_STATUS.RUNNING ||
    existingStatus === STREAM_STATUS.RESUMING
  ) {
    return { success: false };
  }

  ToolUseFollowUpQueue.acquire(streamId);
  StreamStatusService.set(streamId, STREAM_STATUS.RESUMING);

  let queuedFollowUps: string[] = [];
  try {
    // Drain queued follow-ups before starting the flow
    queuedFollowUps = ToolUseFollowUpQueue.drain(streamId);
    // Update UI to show queue is now empty (messages are being processed)
    updateQueuedFollowUpsUI(streamId);

    // Resume using flow-first execution
    await resumeToolUseFromSnapshot(snapshot, (session) => {
      // Combine all follow-ups into a single message
      const allFollowUps: string[] = [];

      // Add explicit follow-up first if provided
      if (followUp !== undefined) {
        allFollowUps.push(followUp);
      }

      // Add queued follow-ups
      allFollowUps.push(...queuedFollowUps);

      // Send as single concatenated message
      if (allFollowUps.length > 0) {
        const combinedMessage = allFollowUps.join('\n\n');
        session.appendFollowUp(combinedMessage);
      }
    });

    return { success: true };
  } catch (error) {
    const lostFollowUps =
      queuedFollowUps.length > 0
        ? queuedFollowUps
        : ToolUseFollowUpQueue.drain(streamId);

    const baseMessage = logErrorMessage(
      CHANNEL,
      'Failed to resume tool-use session',
      error,
    );
    const lostCount = lostFollowUps.length;

    await vscode.window.showWarningMessage(
      `${baseMessage}${lostCount === 0 ? '' : formatLostFollowUpSuffix(lostCount)}`,
    );

    return { success: false, lostFollowUps: lostCount };
  } finally {
    // If still resuming (flow didn't complete successfully), revert to waiting
    const status = StreamStatusService.get(streamId);
    if (status === STREAM_STATUS.RESUMING) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
    }
  }
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerResumeAgentCommand(
  _context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'texra.resumeAgent',
    async (
      payload: ResumeAgentCommandPayload | undefined,
    ): Promise<ResumeAgentResult> => {
      const snapshot = payload?.snapshot;
      if (!snapshot) {
        return { success: false };
      }

      return resumeFromSnapshot(snapshot, payload?.followUp);
    },
  );
}
