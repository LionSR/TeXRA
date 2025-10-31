// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  resumeFromSnapshot,
  type ResumeAgentResult,
} from '@agent/toolUse/ToolUseFollowUpCoordinator';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
  followUp?: string;
}

export function registerResumeAgentCommand(
  _context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'texra.resumeAgent',
    async (
      payload: ResumeAgentCommandPayload | undefined,
    ): Promise<ResumeAgentResult> => {
      if (!payload?.snapshot) {
        return { success: false };
      }

      if (!ToolUseSessionManager.isPersistenceEnabled()) {
        return { success: false };
      }

      return resumeFromSnapshot(payload.snapshot, payload.followUp);
    },
  );
}

export type { ResumeAgentResult } from '@agent/toolUse/ToolUseFollowUpCoordinator';
