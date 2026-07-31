import * as vscode from 'vscode';

import {
  createProgressHostInteractions,
  type ProgressHostInteractions,
  type ProgressHostInteractionsOptions,
} from '@controllers/progressView/backend/progressHostInteractions';
import { pushManualCriticism } from '@frontend/latex/inlineCriticism';
import { getLinterMessages } from '@frontend/latex/linter';

/**
 * The shared progress-view host port plus the capabilities only the VS Code
 * host can serve: workspace diagnostics, inline criticism, and native
 * notifications.
 */
export function createExtensionHostInteractions(
  options: ProgressHostInteractionsOptions,
): ProgressHostInteractions {
  return {
    ...createProgressHostInteractions(options),
    readDiagnostics: getLinterMessages,
    addCriticism: (payload) => {
      const accepted = pushManualCriticism(payload);
      return { accepted, resolvedPath: payload.absolutePath };
    },
    notifyUnavailableTools: (message, actionCommand, actionLabel) => {
      if (!actionCommand) {
        void vscode.window.showInformationMessage(message);
        return;
      }
      const label = actionLabel ?? 'Open Tools Dashboard';
      void vscode.window
        .showInformationMessage(message, label)
        .then((choice) => {
          if (choice === label) {
            void vscode.commands.executeCommand(actionCommand);
          }
        });
    },
  };
}
