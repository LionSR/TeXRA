// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { resumeToolUseSnapshot } from '@agent/runtime/resumeToolUseSnapshot';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';

interface ResumeAgentResult {
  success: boolean;
}

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
  followUp?: string;
}

const CHANNEL = 'resumeCommand';

/**
 * Extension wrapper around the host-neutral {@link resumeToolUseSnapshot}: it
 * supplies the extension runtime host and surfaces failures as a warning toast.
 * Used by both the `texra.resumeAgent` command and the resume orchestrator.
 */
export function resumeExtensionToolUseSnapshot(
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<boolean> {
  return resumeToolUseSnapshot(snapshot, {
    runtimeHost: extensionAgentRuntimeHost,
    explicitFollowUp: followUp,
    reportFailure: async (error) => {
      const baseMessage = logErrorMessage(
        CHANNEL,
        'Failed to resume tool-use session',
        error,
      );
      await vscode.window.showWarningMessage(baseMessage);
    },
  });
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
      if (StreamStatusService.isActiveOrResuming(snapshot.streamId)) {
        return { success: false };
      }

      const success = await resumeExtensionToolUseSnapshot(
        snapshot,
        payload?.followUp,
      );
      return { success };
    },
  );
}
