// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { INSTRUCTION_PREFIX, globalSM } from '@common/state';

const NEVER_REMIND = 'Never remind again';

/**
 * Show an instruction message that can be permanently dismissed.
 *
 * @param key Unique key for the instruction
 * @param message Message to display to the user
 * @param actions Optional action buttons with callbacks
 * @param showSuppress Whether to show the "Never remind again" option
 */
export async function showInstructionWithSuppress(
  key: string,
  message: string,
  actions: { title: string; callback: () => Thenable<void> | void }[] = [],
  showSuppress = true,
): Promise<void> {
  const stateKey = `${INSTRUCTION_PREFIX}${key}`;

  if (showSuppress && globalSM.get<boolean>(stateKey)) {
    return;
  }

  const buttons = actions.map((a) => a.title);
  if (showSuppress) buttons.push(NEVER_REMIND);

  const choice = await vscode.window.showInformationMessage(
    message,
    ...buttons,
  );
  if (!choice) return;

  if (showSuppress && choice === NEVER_REMIND) {
    await globalSM.update(stateKey, true);
    return;
  }

  const action = actions.find((a) => a.title === choice);
  await action?.callback();
}
