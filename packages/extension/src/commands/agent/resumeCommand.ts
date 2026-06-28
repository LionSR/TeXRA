// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

import {
  requestRuntimeToolUseSnapshotResume,
  type RuntimeToolUseSessionSnapshot,
} from '@agent/runtime/resumeCommands';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { logErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getToolUsePersistenceEnabled } from '@utils/config';

export const ResumeAgentResultSchema = z.object({
  success: z.boolean(),
});

export type ResumeAgentResult = z.infer<typeof ResumeAgentResultSchema>;

interface ResumeAgentCommandPayload {
  snapshot: RuntimeToolUseSessionSnapshot;
  followUp?: string;
}

const CHANNEL = 'resumeCommand';

async function resumeFromSnapshot(
  snapshot: RuntimeToolUseSessionSnapshot,
  followUp?: string,
): Promise<ResumeAgentResult> {
  if (!getToolUsePersistenceEnabled()) {
    return { success: false };
  }

  try {
    const success = await requestRuntimeToolUseSnapshotResume({
      snapshot,
      runtimeHost: extensionAgentRuntimeHost,
      followUp,
    });
    return { success };
  } catch (error) {
    const baseMessage = logErrorMessage(
      CHANNEL,
      'Failed to resume tool-use session',
      error,
    );
    await vscode.window.showWarningMessage(baseMessage);

    return { success: false };
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
