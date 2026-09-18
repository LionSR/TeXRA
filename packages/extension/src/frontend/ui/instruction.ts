// Third-party imports
import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { createLog } from '@logger/logUtils';
import type { StateStore, StateWriteFailed } from '@platform/interfaces';
import { INSTRUCTION_PREFIX } from '@shared/state/stateKeys';

const NEVER_REMIND = 'Never remind again';
const CHANNEL = 'instruction';
const log = createLog(CHANNEL);

function handleInstructionChoice(
  store: StateStore,
  stateKey: string,
  showSuppress: boolean,
  actions: { title: string; callback: () => Thenable<void> | void }[],
  choice: string | undefined,
): Effect.Effect<void, StateWriteFailed> {
  if (!choice) return Effect.void;
  // The dismissal write is the caller's own program: this prompt runs on
  // whichever runtime settles the Effect, so there is no runtime to look up
  // and no unpersistable choice to report.
  if (showSuppress && choice === NEVER_REMIND) {
    return store.update(stateKey, true);
  }
  const action = actions.find((a) => a.title === choice);
  return action === undefined
    ? Effect.void
    : Effect.promise(async () => {
        await action.callback();
      });
}

/** Show an instruction message that can be permanently dismissed. */
export function showInstructionWithSuppress(
  store: StateStore,
  key: string,
  message: string,
  actions: { title: string; callback: () => Thenable<void> | void }[] = [],
  showSuppress = true,
  options: { deferDismissal?: boolean } = {},
): Effect.Effect<void, StateWriteFailed> {
  return Effect.suspend(() => {
    const stateKey = `${INSTRUCTION_PREFIX}${key}`;

    if (showSuppress && store.get<boolean>(stateKey)) {
      return Effect.void;
    }

    const buttons = actions.map((a) => a.title);
    if (showSuppress) buttons.push(NEVER_REMIND);

    // Shown here, before the settlement below: a deferred caller returns once
    // VS Code has accepted the dialog, not once the user dismisses it.
    const prompt = vscode.window.showInformationMessage(message, ...buttons);
    const settle = Effect.promise(() => Promise.resolve(prompt)).pipe(
      Effect.flatMap((choice) =>
        handleInstructionChoice(store, stateKey, showSuppress, actions, choice),
      ),
    );

    if (!options.deferDismissal) return settle;
    return settle.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log.warn(`Failed to settle instruction "${key}"`, {
            data: Cause.squash(cause),
          });
        }),
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
): Effect.Effect<void, StateWriteFailed> {
  return Effect.gen(function* () {
    let install = false;
    yield* showInstructionWithSuppress(store, opts.suppressKey, opts.message, [
      {
        title: 'Install',
        // The action records the answer; the install itself is a step of this
        // program, so it composes instead of being run from the callback.
        callback: () => {
          install = true;
        },
      },
    ]);
    if (install) {
      yield* safeExecuteCommand(
        'workbench.extensions.installExtension',
        [opts.extensionId],
        opts.channel,
      );
    }
  });
}
