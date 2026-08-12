// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { globalSM } from '@common/state';
import { INSTRUCTION_PREFIX } from '@shared/state/stateKeys';
import { safeExecuteCommand } from '@frontend/system/commandUtils';

const NEVER_REMIND = 'Never remind again';

/** Show an instruction message that can be permanently dismissed. */
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

/**
 * Prompt the user to install a VS Code extension, with a suppressible
 * "Never remind again" option. Fires the install command on confirm and
 * warns on failure via {@link safeExecuteCommand}.
 */
export async function promptExtensionInstall(opts: {
  suppressKey: string;
  message: string;
  extensionId: string;
  channel: string;
}): Promise<void> {
  await showInstructionWithSuppress(opts.suppressKey, opts.message, [
    {
      title: 'Install',
      callback: () =>
        safeExecuteCommand(
          'workbench.extensions.installExtension',
          [opts.extensionId],
          opts.channel,
        ),
    },
  ]);
}
