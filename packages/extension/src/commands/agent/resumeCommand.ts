// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { resumeQueuedToolUseSnapshot } from '@agent/runtime/resumeQueuedToolUse';
import type { ToolUseResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { registerCommands } from '@commands/_shared/registerCommands';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getToolUsePersistenceEnabled } from '@utils/config';

interface ResumeAgentResult {
  success: boolean;
}

interface ResumeAgentCommandPayload {
  snapshot: ToolUseResumeData;
  followUp?: string;
}

const CHANNEL = 'resumeCommand';

/**
 * Extension wrapper around the host-neutral
 * {@link resumeQueuedToolUseSnapshot}: it supplies the extension runtime host
 * and surfaces failures as a warning toast.
 * Used by both the `texra.resumeAgent` command and the resume orchestrator.
 *
 * The tool-use persistence gate is applied here (extension-only): the desktop
 * never honored this setting, so it stays out of the shared leaf and lives in
 * this adapter to preserve each host's pre-unification resume behavior.
 */
export function resumeExtensionToolUseSnapshot(
  resume: ToolUseResumeData,
  followUp?: string,
): Promise<boolean> {
  if (!getToolUsePersistenceEnabled()) {
    return Promise.resolve(false);
  }
  return resumeQueuedToolUseSnapshot(
    resume.streamId,
    resume,
    extensionAgentRuntimeHost,
    {
      ...(followUp !== undefined && {
        extraFollowUps: [{ text: followUp, origin: 'user' as const }],
      }),
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
}

export function registerResumeAgentCommand(
  context: vscode.ExtensionContext,
): void {
  registerCommands(context, [
    {
      id: 'texra.resumeAgent',
      handler: async (
        payload: ResumeAgentCommandPayload | undefined,
      ): Promise<ResumeAgentResult> => {
        const resume = payload?.snapshot;
        if (!resume) {
          return { success: false };
        }
        if (defaultSession().status.isActiveOrResuming(resume.streamId)) {
          return { success: false };
        }

        const success = await resumeExtensionToolUseSnapshot(
          resume,
          payload?.followUp,
        );
        return { success };
      },
    },
  ]);
}
