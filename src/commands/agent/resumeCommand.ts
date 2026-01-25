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
import { STREAM_STATUS } from '@shared/schemas';
import { resumeToolUseFromSnapshot } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { logErrorMessage } from '@common/errors/errorHandlingUtils';
import { getToolUsePersistenceEnabled } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';

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

  const { streamId } = snapshot;

  // Guard against concurrent resume attempts
  if (StreamStatusService.isActiveOrResuming(streamId)) {
    return { success: false };
  }

  ToolUseFollowUpQueue.acquire(streamId);
  StreamStatusService.set(streamId, STREAM_STATUS.RESUMING);

  let queuedFollowUps: string[] = [];
  try {
    // Drain queued follow-ups before starting the flow
    queuedFollowUps = ToolUseFollowUpQueue.drain(streamId);
    // Update UI to show queue is now empty (messages are being processed)
    bus.emit('updateQueuedFollowUps', { streamId });

    // Resume using flow-first execution
    await resumeToolUseFromSnapshot(snapshot, (session) => {
      // Combine explicit follow-up with queued ones into a single message
      const allFollowUps =
        followUp !== undefined
          ? [followUp, ...queuedFollowUps]
          : queuedFollowUps;

      if (allFollowUps.length > 0) {
        session.appendFollowUp(allFollowUps.join('\n\n'));
      }
    });

    return { success: true };
  } catch (error) {
    // Use already-drained follow-ups if available, otherwise drain now
    const lostFollowUps =
      queuedFollowUps.length > 0
        ? queuedFollowUps
        : ToolUseFollowUpQueue.drain(streamId);
    const lostCount = lostFollowUps.length;

    const baseMessage = logErrorMessage(
      CHANNEL,
      'Failed to resume tool-use session',
      error,
    );
    let lostSuffix = '';
    if (lostCount > 0) {
      const label = lostCount === 1 ? 'follow-up was' : 'follow-ups were';
      lostSuffix = ` ${lostCount} queued ${label} lost.`;
    }
    await vscode.window.showWarningMessage(`${baseMessage}${lostSuffix}`);

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
