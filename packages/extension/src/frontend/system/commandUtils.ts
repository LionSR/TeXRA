// Third-party imports
import { Effect, Schema } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { ToolMissingHandler } from '@texra-ai/harness/host';

const DEFAULT_CHANNEL = 'commandUtils';

/**
 * A VS Code command the extension dispatched and VS Code refused.
 *
 * `not-registered` is the host saying the id does not exist. VS Code reports
 * an unregistered id in the message text and nowhere else, so the text is
 * read once, beside the dispatch, and callers match `reason`.
 */
class VscodeCommandRefused extends Schema.TaggedError<VscodeCommandRefused>()(
  'VscodeCommandRefused',
  {
    reason: Schema.Literals(['not-registered', 'failed']),
    commandId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Dispatch one VS Code command, naming an unregistered id as its own
 *  reason. The one lift of `vscode.commands.executeCommand`: a caller that
 *  answers with its own failure maps this one onto it. */
export function executeVscodeCommand<T = void>(
  commandId: string,
  ...args: unknown[]
): Effect.Effect<T | undefined, VscodeCommandRefused> {
  return Effect.tryPromise({
    try: () =>
      Promise.resolve(vscode.commands.executeCommand<T>(commandId, ...args)),
    catch: (cause) => {
      const message = toErrorMessage(cause);
      return new VscodeCommandRefused({
        reason: message.includes(`command '${commandId}' not found`)
          ? 'not-registered'
          : 'failed',
        commandId,
        message,
        cause,
      });
    },
  });
}

/** Execute a VS Code command, reporting a rejection once and answering
 *  `undefined` in its place. */
export function safeExecuteCommand<T>(
  command: string,
  args: unknown[] = [],
  channel: string = DEFAULT_CHANNEL,
): Effect.Effect<T | undefined> {
  return executeVscodeCommand<T>(command, ...args).pipe(
    Effect.catch((err) =>
      showLoggedErrorMessage(
        channel,
        `Error executing command ${command}`,
        err,
      ).pipe(Effect.as(undefined)),
    ),
  );
}

/** The VS Code host's `ToolMissingReporter`: log and show the message, and
 *  open the tool's docs page when the user asks for it. */
export const vscodeToolMissingReporter: ToolMissingHandler = (
  message,
  docsPage,
) =>
  Effect.logError(message).pipe(
    Effect.andThen(
      vscodeUi.error(message, {
        items: docsPage ? ['View Installation Guide'] : [],
      }),
    ),
    Effect.flatMap((choice) =>
      choice && docsPage ? openGuidePage(docsPage) : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logError('Tool-missing notice failed', error),
    ),
    withLogChannel(DEFAULT_CHANNEL),
  );
