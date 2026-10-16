// Third-party imports
import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness';
import { z } from 'zod';
import { Settings } from '@texra-ai/harness';
import { ensureError } from '@texra-ai/harness/schemas';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import type {
  StateStore,
  StateReadFailed,
  StateWriteFailed,
} from '@texra-ai/harness';

const NEVER_REMIND = 'Never remind again';
const CHANNEL = 'instruction';

/** Prefix of each instruction's suppression flag in global state. */
const INSTRUCTION_PREFIX = 'instruction.';

/** A suppression flag is off until the user dismisses its instruction. */
const SuppressedSchema = z.boolean().prefault(false);

/** Show an instruction message that can be permanently dismissed. */
export function showInstructionWithSuppress(
  store: StateStore,
  key: string,
  message: string,
  actions: { title: string; callback: () => Effect.Effect<void> }[] = [],
  showSuppress = true,
  options: { deferDismissal?: boolean } = {},
): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
  return Effect.gen(function* () {
    const stateKey = `${INSTRUCTION_PREFIX}${key}`;

    if (
      showSuppress &&
      (yield* Settings.state(store, stateKey, SuppressedSchema))
    ) {
      return;
    }

    const buttons = actions.map((a) => a.title);
    if (showSuppress) buttons.push(NEVER_REMIND);

    // Shown here, before the settlement below: a deferred caller returns once
    // VS Code has accepted the dialog, not once the user dismisses it.
    const prompt = vscode.window.showInformationMessage(message, ...buttons);
    const settle = Effect.tryPromise({
      try: () => Promise.resolve(prompt),
      catch: ensureError,
    }).pipe(
      // A prompt VS Code would not show is a logged non-answer.
      Effect.catch((error) =>
        Effect.logWarning(`Instruction "${key}" was not shown`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
          Effect.as(undefined),
        ),
      ),
      Effect.flatMap((choice): Effect.Effect<void, StateWriteFailed> => {
        if (!choice) return Effect.void;
        // The dismissal write is the caller's own program: this prompt runs
        // on whichever runtime settles the Effect, so there is no runtime to
        // look up and no unpersistable choice to report.
        if (showSuppress && choice === NEVER_REMIND) {
          return store.update(stateKey, true);
        }
        const action = actions.find((a) => a.title === choice);
        return action === undefined ? Effect.void : action.callback();
      }),
    );

    if (!options.deferDismissal) return yield* settle;
    return yield* settle.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Failed to settle instruction "${key}"`).pipe(
          Effect.annotateLogs({ data: Cause.squash(cause) }),
          withLogChannel(CHANNEL),
        ),
      ),
      Effect.forkDetach,
      Effect.asVoid,
    );
  });
}

/**
 * Prompt the user to install a VS Code extension, with a suppressible
 * "Never remind again" option. Fires the install command on confirm and
 * warns on failure via {@link safeExecuteCommand}.
 */
export function promptExtensionInstall(
  store: StateStore,
  opts: {
    suppressKey: string;
    message: string;
    extensionId: string;
    channel: string;
  },
): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
  return showInstructionWithSuppress(store, opts.suppressKey, opts.message, [
    {
      title: 'Install',
      callback: () =>
        safeExecuteCommand(
          'workbench.extensions.installExtension',
          [opts.extensionId],
          opts.channel,
        ).pipe(Effect.asVoid),
    },
  ]);
}
