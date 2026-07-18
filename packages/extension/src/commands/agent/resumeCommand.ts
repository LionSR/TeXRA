// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { resumeQueuedToolUseSnapshot } from '@agent/runtime/resumeQueuedToolUse';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { registerCommands } from '@commands/_shared/registerCommands';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getToolUsePersistenceEnabled } from '@utils/config';

interface ResumeAgentResult {
  success: boolean;
}

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
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
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<boolean> {
  if (!getToolUsePersistenceEnabled()) {
    return Promise.resolve(false);
  }
  return resumeQueuedToolUseSnapshot(
    snapshot.streamId,
    snapshot,
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
        const snapshot = payload?.snapshot;
        if (!snapshot) {
          return { success: false };
        }
        if (defaultSession().status.isActiveOrResuming(snapshot.streamId)) {
          return { success: false };
        }

        const success = await resumeExtensionToolUseSnapshot(
          snapshot,
          payload?.followUp,
        );
        return { success };
      },
    },
  ]);
}
