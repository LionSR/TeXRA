import { Cause, Effect } from 'effect';

import type { ProcessServices } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setTransientNotice } from '../state/cliState';
import { appendLocalAssistantTranscript } from '../state/transcript';
import {
  type SlashCommandContext,
  type SlashCommandEffect,
} from './handlers/slashContext';
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

/**
 * Run a command body with centralized echo and error persistence. A typed
 * failure and a throw from the body alike reach the transcript, which is what
 * the `try`/`catch` around the awaited handler did before it became a
 * program. Interruption is not folded in: a fiber the runtime is tearing down
 * did not fail the command.
 */
function runGuardedSlashCommand(
  line: string,
  command: SlashCommand,
  action: () => SlashCommandEffect,
): Effect.Effect<void, unknown, ProcessServices> {
  return Effect.suspend(() => {
    let echoed = false;
    const echo = (): void => {
      if (echoed) return;
      appendSlashCommandEcho(line);
      echoed = true;
    };
    if (command.echo === 'ifPersists') echo();
    return Effect.suspend(action).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => {
              echo();
              appendLocalAssistantTranscript(
                toErrorMessage(Cause.squash(cause)),
              );
            }),
      ),
    );
  });
}

export function handleTuiSlashCommand(
  line: string,
  context: SlashCommandContext,
): Effect.Effect<boolean, unknown, ProcessServices> {
  return Effect.gen(function* () {
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
    const handler = registered?.handler;
    if (registered && handler) {
      yield* runGuardedSlashCommand(line, registered, () =>
        handler(rest, context),
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
      yield* runGuardedSlashCommand(line, registered, () =>
        Effect.fail(
          new Error(
            `/${parsed.name} is registered but is not available in this CLI view yet.`,
          ),
        ),
      );
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
  });
}
