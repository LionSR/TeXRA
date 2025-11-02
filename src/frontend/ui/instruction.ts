// Third-party imports
import * as vscode from 'vscode';

// Standard library imports
import * as path from 'path';

// Local imports
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { INSTRUCTION_PREFIX, globalSM } from '@common/state/stateManager';

/**
 * Show an instruction message that can be permanently dismissed.
 *
 * @param key Unique key for the instruction
 * @param message Message to display to the user
 */
export async function showInstructionWithSuppress(
  key: string,
  message: string,
  actions: { title: string; callback: () => Thenable<void> | void }[] = [],
  showSuppress = true,
): Promise<void> {
  if (showSuppress) {
    const dismissed = globalSM.get<boolean>(`${INSTRUCTION_PREFIX}${key}`);
    if (dismissed) {
      return;
    }
  }

  const never = 'Never remind again';
  const buttons = actions.map((a) => a.title);
  const choice = await vscode.window.showInformationMessage(
    message,
    ...buttons,
    ...(showSuppress ? [never] : []),
  );

  if (showSuppress && choice === never) {
    await globalSM.update(`${INSTRUCTION_PREFIX}${key}`, true);
  } else if (choice) {
    const action = actions.find((a) => a.title === choice);
    await action?.callback();
  }
}

/**
 * Validate that expected output files exist. If any are missing,
 * show a reminder about checking the XML output.
 */
