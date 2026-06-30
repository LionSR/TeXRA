// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { resumeQueuedToolUseSnapshot } from '@agent/runtime/resumeQueuedToolUse';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
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

  const success = await resumeQueuedToolUseSnapshot(
    streamId,
    snapshot,
    extensionAgentRuntimeHost,
    {
      extraFollowUps:
        followUp !== undefined
          ? [{ text: followUp, origin: 'user' as const }]
          : [],
      onError: async (error) => {
        const baseMessage = logErrorMessage(
          CHANNEL,
          'Failed to resume tool-use session',
          error,
        );
        await vscode.window.showWarningMessage(baseMessage);
      },
    },
  );
  return { success };
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
