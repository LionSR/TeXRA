// Third-party imports
import { Cause, Effect, FiberHandle, FileSystem } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness/host';
import type { FileLocation } from '@texra-ai/harness/schemas';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { refreshDiffOnLayoutChange } from '@frontend/ui/diffView';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';

const CHANNEL = 'CompareCommands';

const validateFilesExist = Effect.fnUntraced(function* (
  baseLocation: FileLocation,
  editedLocation: FileLocation,
) {
  const fs = yield* FileSystem.FileSystem;
  const required: ReadonlyArray<readonly [string, FileLocation]> = [
    ['Base', baseLocation],
    ['Edited', editedLocation],
  ];
  for (const [label, location] of required) {
    if (!(yield* fs.exists(location.absolutePath))) {
      yield* showLoggedMessage(
        `${label} file not found: ${location.absolutePath}`,
      );
      return false;
    }
  }

  return true;
});

export const handleCompare = Effect.fn('compareCommands.handleCompare')(
  function* (
    baseLocation: FileLocation,
    editedLocation: FileLocation,
    title: string,
    /** The window's diff refresh, which this comparison takes over. */
    diffRefresh: FiberHandle.FiberHandle,
  ) {
    if (!(yield* validateFilesExist(baseLocation, editedLocation))) {
      return;
    }

    const baseUri = vscode.Uri.file(baseLocation.absolutePath);
    const editedUri = vscode.Uri.file(editedLocation.absolutePath);

    const contextKeyCommandId = 'vscode.getContextKeyValue';
    // A host without the context-key command cannot report where the view
    // lives; the diff still opens. Every other failure fails the compare.
    const location = yield* executeVscodeCommand<string>(
      contextKeyCommandId,
      'viewContainerLocation:texra',
    ).pipe(
      Effect.catchIf(
        (error) => error.reason === 'not-registered',
        () =>
          Effect.logWarning(
            `Could not check Progress view location: command '${contextKeyCommandId}' not found`,
          ).pipe(Effect.as(undefined)),
      ),
    );

    if (location === 'secondarySideBar') {
      yield* executeVscodeCommand('workbench.action.closePanel');
    }

    yield* executeVscodeCommand('vscode.diff', editedUri, baseUri, title);

    // One refresh per window: this comparison's replaces the last one's.
    yield* FiberHandle.run(
      diffRefresh,
      refreshDiffOnLayoutChange(editedUri, baseUri, title),
    );

    yield* Effect.logInfo(
      `Opened diff comparison between ${baseLocation.absolutePath} and ${editedLocation.absolutePath}`,
    );
  },
  Effect.catchCause((cause) =>
    showLoggedErrorMessage('Error comparing files', Cause.squash(cause)).pipe(
      Effect.asVoid,
    ),
  ),
  withLogChannel(CHANNEL),
);
