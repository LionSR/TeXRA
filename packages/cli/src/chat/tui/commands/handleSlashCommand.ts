import { Cause, Effect } from 'effect';

import { toErrorMessage } from '@texra-ai/harness/schemas';

import { setTransientNotice } from '../state/cliState';
import { appendLocalErrorTranscript } from '../state/transcript';
import {
  type SlashCommandContext,
  type SlashCommandEffect,
} from './handlers/slashContext';
import {
  appendSlashCommandEcho,
  openRegisteredCliSlashForm,
} from './slashForms';
import {
  parseSlashInput,
  type SlashCommand,
  type SlashCommands,
} from './slashRegistry';
import type { ProcessServices } from '@texra-ai/harness/host';

/**
 * Run a command body with centralized echo and error persistence. A typed
 * failure and a throw from the body alike reach the transcript, which is what
 * the `try`/`catch` around the awaited handler did before it became a
 * program. Interruption is not turned into a failure: a fiber the runtime is tearing down
 * did not fail the command.
 */
function runGuardedSlashCommand(
  commands: SlashCommands,
  line: string,
  command: SlashCommand,
  action: () => SlashCommandEffect,
): Effect.Effect<void, Error, ProcessServices> {
  return Effect.suspend(() => {
    let echoed = false;
    const echo = (): void => {
      if (echoed) return;
      appendSlashCommandEcho(commands, line);
      echoed = true;
    };
    if (command.echo === 'ifPersists') echo();
    return Effect.suspend(action).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => {
              echo();
              appendLocalErrorTranscript(toErrorMessage(cause));
            }),
      ),
    );
  });
}

export const handleTuiSlashCommand = Effect.fn('handleTuiSlashCommand')(
  function* (
    line: string,
    context: SlashCommandContext,
  ): Effect.fn.Return<boolean, Error, ProcessServices> {
    const { commands } = context;
    const redactedIntent = commands.findRedacted(line);
    const parsed = parseSlashInput(line);
    if (!parsed) {
      if (!redactedIntent) return false;
      setTransientNotice(
        `For safety, /${redactedIntent.name} accepts credentials only through its masked form.`,
      );
      if (
        !openRegisteredCliSlashForm(redactedIntent, () =>
          appendSlashCommandEcho(commands, line),
        )
      ) {
        setTransientNotice(
          `/${redactedIntent.name} is not available in this CLI view yet.`,
        );
      }
      return true;
    }

    const rest = parsed.remainder.trim();
    const registered = commands.find(parsed.name) ?? redactedIntent;
    if (
      registered?.formComponent !== undefined &&
      (!rest || registered.formRemainders?.includes(rest.toLowerCase()))
    ) {
      openRegisteredCliSlashForm(registered, () =>
        appendSlashCommandEcho(commands, line),
      );
      return true;
    }
    const handler = registered?.handler;
    if (registered && handler) {
      yield* runGuardedSlashCommand(commands, line, registered, () =>
        handler(rest, context),
      );
      return true;
    }
    if (registered) {
      if (
        openRegisteredCliSlashForm(registered, () =>
          appendSlashCommandEcho(commands, line),
        )
      ) {
        return true;
      }
      yield* runGuardedSlashCommand(commands, line, registered, () =>
        Effect.fail(
          new Error(
            `/${parsed.name} is registered but is not available in this CLI view yet.`,
          ),
        ),
      );
      return true;
    }

    const suggestion = commands.suggest(parsed.name.toLowerCase());
    const didYouMean = suggestion ? ` Did you mean /${suggestion.name}?` : '';
    setTransientNotice(
      commands.shouldRedact(line)
        ? 'Unknown command with protected input. Type /help to list commands.'
        : `Unknown command: /${parsed.name}.${didYouMean} Type /help to list commands.`,
    );
    return true;
  },
);
