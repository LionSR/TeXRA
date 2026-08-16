// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { globalSM } from '@common/state';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { createLog } from '@logger/logUtils';
import { INSTRUCTION_PREFIX } from '@shared/state/stateKeys';

const NEVER_REMIND = 'Never remind again';
const CHANNEL = 'instruction';
const log = createLog(CHANNEL);

async function handleInstructionChoice(
  stateKey: string,
  showSuppress: boolean,
  actions: { title: string; callback: () => Thenable<void> | void }[],
  choice: string | undefined,
): Promise<void> {
  if (!choice) return;

  if (showSuppress && choice === NEVER_REMIND) {
    await globalSM.update(stateKey, true);
    return;
  }

  const action = actions.find((a) => a.title === choice);
  await action?.callback();
}

/** Show an instruction message that can be permanently dismissed. */
export async function showInstructionWithSuppress(
  key: string,
  message: string,
  actions: { title: string; callback: () => Thenable<void> | void }[] = [],
  showSuppress = true,
  options: { deferDismissal?: boolean } = {},
): Promise<void> {
  const stateKey = `${INSTRUCTION_PREFIX}${key}`;

  if (showSuppress && globalSM.get<boolean>(stateKey)) {
    return;
  }

  const buttons = actions.map((a) => a.title);
  if (showSuppress) buttons.push(NEVER_REMIND);

  const prompt = vscode.window.showInformationMessage(message, ...buttons);

  if (options.deferDismissal) {
    void Promise.resolve(prompt)
      .then((choice) =>
        handleInstructionChoice(stateKey, showSuppress, actions, choice),
      )
      .catch((error: unknown) => {
        log.warn(`Failed to settle instruction "${key}"`, {
          data: error,
        });
      });
    return;
  }

  await handleInstructionChoice(stateKey, showSuppress, actions, await prompt);
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
