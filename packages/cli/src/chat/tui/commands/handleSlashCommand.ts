import { toErrorMessage } from '@utils/errors/errorMessage';

import { setTransientNotice } from '../state/cliState';
import { appendLocalAssistantTranscript } from '../state/transcript';
import { type SlashCommandContext } from './handlers/slashContext';
import {
  appendSlashCommandEcho,
  openRegisteredCliSlashForm,
} from './slashForms';
import {
  findSlashCommand,
  findRedactedSlashCommandInput,
  parseSlashInput,
  shouldRedactSlashInput,
  suggestSlashCommand,
  type SlashCommand,
} from './slashRegistry';

/** Run a command body with centralized echo and error persistence. */
async function runGuardedSlashCommand(
  line: string,
  command: SlashCommand,
  action: () => void | Promise<void>,
): Promise<void> {
  let echoed = false;
  const echo = (): void => {
    if (echoed) return;
    appendSlashCommandEcho(line);
    echoed = true;
  };
  try {
    if (command.echo === 'ifPersists') echo();
    await action();
  } catch (error: unknown) {
    echo();
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

export async function handleTuiSlashCommand(
  line: string,
  context: SlashCommandContext,
): Promise<boolean> {
  const redactedIntent = findRedactedSlashCommandInput(line);
  const parsed = parseSlashInput(line);
  if (!parsed) {
    if (!redactedIntent) return false;
    setTransientNotice(
      `For safety, /${redactedIntent.name} accepts credentials only through its masked form.`,
    );
    if (
      !openRegisteredCliSlashForm(redactedIntent, '', () =>
        appendSlashCommandEcho(line),
      )
    ) {
      setTransientNotice(
        `/${redactedIntent.name} is not available in this CLI view yet.`,
      );
    }
    return true;
  }

  const rest = parsed.remainder.trim();
  const registered = findSlashCommand(parsed.name) ?? redactedIntent;
  if (
    registered?.formComponent !== undefined &&
    (!rest || registered.formRemainders?.includes(rest.toLowerCase()))
  ) {
    openRegisteredCliSlashForm(registered, rest, () =>
      appendSlashCommandEcho(line),
    );
    return true;
  }
  if (registered?.handler) {
    await runGuardedSlashCommand(line, registered, () =>
      registered.handler?.(rest, context),
    );
    return true;
  }
  if (registered) {
    if (
      openRegisteredCliSlashForm(registered, parsed.remainder, () =>
        appendSlashCommandEcho(line),
      )
    ) {
      return true;
    }
    await runGuardedSlashCommand(line, registered, () => {
      throw new Error(
        `/${parsed.name} is registered but is not available in this CLI view yet.`,
      );
    });
    return true;
  }

  const suggestion = suggestSlashCommand(parsed.name.toLowerCase());
  const didYouMean = suggestion ? ` Did you mean /${suggestion.name}?` : '';
  setTransientNotice(
    shouldRedactSlashInput(line)
      ? 'Unknown command with protected input. Type /help to list commands.'
      : `Unknown command: /${parsed.name}.${didYouMean} Type /help to list commands.`,
  );
  return true;
}
