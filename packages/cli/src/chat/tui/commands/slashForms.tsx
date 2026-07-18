import { activeForm } from '../state/cliState';
import { appendLocalUserTranscript } from '../state/transcript';

import {
  findSlashCommand,
  shouldRedactSlashInput,
  type SlashCommand,
} from './slashRegistry';

export function appendSlashCommandEcho(line: string): void {
  if (!shouldRedactSlashInput(line)) appendLocalUserTranscript(line.trim());
}

export function openRegisteredCliSlashForm(
  command: SlashCommand,
  remainder: string,
  onPersist?: () => void,
): boolean {
  const Form = command.formComponent;
  if (!Form) return false;
  let persisted = false;
  const persist = (): void => {
    if (persisted) return;
    persisted = true;
    onPersist?.();
  };
  activeForm.set({
    commandName: command.name,
    escapeAction: command.formEscapeAction,
    render: (close, availableRows) => (
      <Form
        availableRows={availableRows}
        remainder={remainder.trimStart()}
        onPersist={onPersist ? persist : undefined}
        echoOnPersist={command.echo === 'ifPersists'}
        onDone={() => close()}
      />
    ),
  });
  return true;
}

export function openCliSlashCommandForm(
  commandName: string,
  remainder: string,
  onPersist?: () => void,
): boolean {
  const command = findSlashCommand(commandName);
  return command
    ? openRegisteredCliSlashForm(command, remainder, onPersist)
    : false;
}
