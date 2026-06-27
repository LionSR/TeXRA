// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { resumeToolUseFromSnapshot } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { STREAM_STATUS } from '@shared/schemas';
import { getToolUsePersistenceEnabled } from '@utils/config';

export const ResumeAgentResultSchema = z.object({
  success: z.boolean(),
});

export type ResumeAgentResult = z.infer<typeof ResumeAgentResultSchema>;

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
  followUp?: string;
}

const CHANNEL = 'resumeCommand';

async function resumeFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<ResumeAgentResult> {
  if (!getToolUsePersistenceEnabled()) {
    return { success: false };
  }

  const { streamId } = snapshot;

  if (StreamStatusService.isActiveOrResuming(streamId)) {
    return { success: false };
  }

  ToolUseFollowUpQueue.acquire(streamId);
  const runtimeHost = extensionAgentRuntimeHost;
  StreamStatusService.set(streamId, STREAM_STATUS.RESUMING, {
    runtimeHost,
  });

  // Seed with the explicit follow-up so the catch path still re-enqueues it
  // even if the drain below throws before the full list is assigned.
  const explicitFollowUp: readonly FollowUpQueueInput[] =
    followUp !== undefined ? [{ text: followUp, origin: 'user' as const }] : [];
  let followUps: readonly FollowUpQueueInput[] = explicitFollowUp;
  try {
    followUps = [
      ...explicitFollowUp,
      ...ToolUseFollowUpQueue.drainItems(streamId),
    ];
    runtimeHost.emit('updateQueuedFollowUps', {
      streamId,
    });

    await resumeToolUseFromSnapshot(snapshot, runtimeHost, {
      setupSession: (session) => {
        for (const item of followUps) {
          session.appendFollowUp(item);
        }
      },
    });

    return { success: true };
  } catch (error) {
    // Re-enqueue the drained follow-ups (and the explicit one, ahead of
    // them) so a later resume picks them up instead of dropping them —
    // matching the desktop bridge's failure path.
    for (const item of followUps) {
      ToolUseFollowUpQueue.enqueue(streamId, item, { force: true });
    }
    if (followUps.length > 0) {
      runtimeHost.emit('updateQueuedFollowUps', { streamId });
    }

    const baseMessage = logErrorMessage(
      CHANNEL,
      'Failed to resume tool-use session',
      error,
    );
    await vscode.window.showWarningMessage(baseMessage);

    return { success: false };
  } finally {
    const status = StreamStatusService.get(streamId);
    if (status === STREAM_STATUS.RESUMING) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        runtimeHost,
      });
    }
  }
}

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
