// Node imports
import * as path from 'node:path';

// Third-party imports
import { Cause, Effect, FiberHandle, FileSystem, Schema } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage, type FileLocation } from '@texra-ai/harness/schemas';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { refreshDiffOnLayoutChange } from '@frontend/ui/diffView';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  acceptEditedFileReplace,
  type CommitAcceptedFilePorts,
} from '@latex/acceptedFileTarget';

const CHANNEL = 'CompareCommands';

/**
 * The host-neutral replace sequence, faulted. It answers a refused replace as
 * `false`, so reaching here is a fault. `message` ends with the rejection's
 * own text, because the reporting tail shows `toErrorMessage` of this failure
 * and the reason the call gave is the part the user can act on.
 */
class AcceptEditedFailed extends Schema.TaggedError<AcceptEditedFailed>()(
  'AcceptEditedFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const replaceFailed = (cause: unknown) =>
  new AcceptEditedFailed({
    message: `The edited file could not replace the original: ${toErrorMessage(cause)}`,
    cause,
  });

/**
 * VS Code bindings for the host-neutral accept-edited sequence that the
 * filesystem cannot answer.
 * The reads and writes themselves are the sequence's own, against the
 * `FileSystem` the host entry's runtime carries.
 */
const acceptPorts: CommitAcceptedFilePorts = {
  showInfo: (message) =>
    Effect.forkDetach(showLoggedInfoMessage(CHANNEL, message)).pipe(
      Effect.asVoid,
    ),
};

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
      yield* Effect.forkDetach(
        showLoggedMessage(
          CHANNEL,
          `${label} file not found: ${location.absolutePath}`,
        ),
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
    /** The window's diff refresh, which this comparison takes over. */
    diffRefresh: FiberHandle.FiberHandle,
  ) {
    if (!(yield* validateFilesExist(baseLocation, editedLocation))) {
      return;
    }

    const baseUri = vscode.Uri.file(baseLocation.absolutePath);
    const editedUri = vscode.Uri.file(editedLocation.absolutePath);
    const baseFileName = path.basename(baseLocation.absolutePath);
    const editedFileName = path.basename(editedLocation.absolutePath);
    const title = `Compare: ${editedFileName} ↔ ${baseFileName}`;

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
          ).pipe(withLogChannel(CHANNEL), Effect.as(undefined)),
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
      `Opened diff comparison between ${baseFileName} and ${editedFileName}`,
    ).pipe(withLogChannel(CHANNEL));
  },
  Effect.catchCause((cause) =>
    showLoggedErrorMessage(
      CHANNEL,
      'Error comparing files',
      Cause.squash(cause),
    ).pipe(Effect.asVoid),
  ),
);

export const handleAcceptEdited = Effect.fn(
  'compareCommands.handleAcceptEdited',
)(
  function* (baseLocation: FileLocation, editedLocation: FileLocation) {
    if (!(yield* validateFilesExist(baseLocation, editedLocation))) {
      return false;
    }
    return yield* acceptEditedFileReplace(baseLocation, editedLocation, {
      ...acceptPorts,
      confirm: (message) =>
        vscodeUi
          .confirm(message, { confirmLabel: 'Replace file' })
          .pipe(Effect.mapError(replaceFailed)),
    }).pipe(
      Effect.catchTag('PlatformError', (error) =>
        Effect.fail(replaceFailed(error)),
      ),
    );
  },
  Effect.catchCause((cause) =>
    showLoggedErrorMessage(
      CHANNEL,
      'Error accepting changes',
      Cause.squash(cause),
    ).pipe(Effect.as(false)),
  ),
);
