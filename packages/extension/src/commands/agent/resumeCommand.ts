// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  defaultSession,
  resumeQueuedToolUseFromResumeData,
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { RecoveryContinuation } from '@platform/interfaces';

interface ResumeAgentResult {
  success: boolean;
}

interface ResumeAgentCommandPayload {
  snapshot: Pick<
    ToolUseResumeData,
    'streamId' | 'executionId' | 'agentConfig' | 'parentStreamId'
  >;
  followUp?: string;
}

const CHANNEL = 'resumeCommand';

async function showResumeError(error: unknown): Promise<void> {
  const message = logErrorMessage(
    CHANNEL,
    'Failed to resume tool-use session',
    error,
  );
  await vscode.window.showWarningMessage(message);
}

/**
 * Extension wrapper around the host-neutral
 * {@link resumeQueuedToolUseFromResumeData}: it supplies the extension runtime host
 * and surfaces failures as a warning toast.
 * Used by both the `texra.resumeAgent` command and the resume orchestrator.
 */
export function resumeExtensionToolUseFromResumeData(
  resume: ToolUseResumeData,
  recovery?: RecoveryContinuation,
  followUp?: string,
): Promise<boolean> {
  return resumeQueuedToolUseFromResumeData(resume.streamId, resume, {
    recovery,
    ...(followUp !== undefined && {
      extraFollowUps: [{ text: followUp, origin: 'user' as const }],
    }),
    onError: showResumeError,
  });
}

export function registerResumeAgentCommand(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.resumeAgent',
      handler: async (
        payload: ResumeAgentCommandPayload | undefined,
      ): Promise<ResumeAgentResult> => {
        const identity = payload?.snapshot;
        if (!identity) {
          return { success: false };
        }
        if (defaultSession().status.isActiveOrResuming(identity.streamId)) {
          return { success: false };
        }

        let resume;
        try {
          resume = await retrieveSessionResumeData(
            identity.streamId,
            identity.executionId,
            identity.agentConfig,
            { parentStreamId: identity.parentStreamId },
          );
        } catch (error) {
          await showResumeError(error);
          return { success: false };
        }
        if (resume?.type !== 'toolUse') return { success: false };
        if (defaultSession().status.isActiveOrResuming(identity.streamId))
          return { success: false };

        const success = await resumeExtensionToolUseFromResumeData(
          resume,
          undefined,
          payload?.followUp,
        );
        return { success };
      },
    },
  ]);
}
