/**
 * VS Code notification for unavailable external tools.
 *
 * Separated from the tool-use flow so the flow runner stays decoupled from
 * the VS Code UI layer.
 */
import * as vscode from 'vscode';

import { mapToolNamesToGroupNames } from '@tools/toolAvailability';

/** Groups already surfaced in a notification this session — avoids repeat popups. */
const notifiedGroups = new Set<string>();

/**
 * Show a single notification listing tool *groups* that were excluded due to
 * missing dependencies, with a button to open the Tools dashboard.
 * Each group is only notified once per session.
 */
export function notifyUnavailableTools(excludedToolNames: string[]): void {
  const groups = mapToolNamesToGroupNames(excludedToolNames);
  const fresh = groups.filter((g) => !notifiedGroups.has(g));
  if (fresh.length === 0) return;
  for (const g of fresh) notifiedGroups.add(g);

  const label =
    fresh.length === 1
      ? `"${fresh[0]}" tools were`
      : `${fresh.map((g) => `"${g}"`).join(', ')} tools were`;

  void vscode.window
    .showInformationMessage(
      `${label} excluded — external dependencies not installed.`,
      'Open Tools Dashboard',
    )
    .then((choice) => {
      if (choice === 'Open Tools Dashboard') {
        void vscode.commands.executeCommand('texra.showTools');
      }
    });
}
