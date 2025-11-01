// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  resumeFromSnapshot,
  type ResumeAgentResult,
} from '@agent/toolUse/ToolUseFollowUpCoordinator';
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
  followUp?: string;
}

export function registerResumeAgentCommand(
  context: vscode.ExtensionContext,
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
