// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { resumeToolUseFromSnapshot } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { STREAM_STATUS } from '@shared/schemas';
import { getToolUsePersistenceEnabled } from '@utils/config';

export const ResumeAgentResultSchema = z.object({
  success: z.boolean(),
  lostFollowUps: z.number().nonnegative().optional(),
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

  let queuedFollowUps: string[] = [];
  try {
    queuedFollowUps = ToolUseFollowUpQueue.drain(streamId);
    runtimeHost.emit('updateQueuedFollowUps', {
      streamId,
    });

    await resumeToolUseFromSnapshot(snapshot, runtimeHost, (session) => {
      const allFollowUps =
        followUp !== undefined
          ? [followUp, ...queuedFollowUps]
          : queuedFollowUps;

      for (const text of allFollowUps) {
        session.appendFollowUp(text);
      }
    });

    return { success: true };
  } catch (error) {
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
