import { activeForm } from '../state/cliState';

import { findSlashCommand, type SlashCommand } from './slashRegistry';

export function openRegisteredCliSlashForm(
  command: SlashCommand,
  remainder: string,
): boolean {
  const Form = command.formComponent;
  if (!Form) return false;
  activeForm.set({
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

export function openCliSlashCommandForm(
  commandName: string,
  remainder: string,
): boolean {
  const command = findSlashCommand(commandName);
  return command ? openRegisteredCliSlashForm(command, remainder) : false;
}
