import { cliState } from '../state/cliState';

import type { SlashCommand } from './slashRegistry';

export function openRegisteredCliSlashForm(
  command: SlashCommand,
  remainder: string,
): boolean {
  const Form = command.formComponent;
  if (!Form) return false;
  cliState.activeForm.set({
    commandName: command.name,
    escapeAction: command.formEscapeAction,
    render: (close, availableRows) => (
      <Form
        availableRows={availableRows}
        remainder={remainder.trimStart()}
        onDone={() => close()}
      />
    ),
  });
  return true;
}
