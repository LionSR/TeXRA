// Node imports
import * as path from 'node:path';

// Third-party imports
import { Cause, Data, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { emitAppSignal } from '@eventBus/AppSignals';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { registerDiffRefresh } from '@frontend/ui/diffView';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  acceptEditedFileReplace,
  commitAcceptedFile,
  getAcceptedFileTarget,
  siblingLocation,
  type CommitAcceptedFilePorts,
} from '@latex/acceptedFileTarget';
import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import type { AcceptCopyMeta, FileLocation } from '@shared/schemas';
import { DIFF_REGISTRATION_DELAY_MS } from '@shared/constants/latexTiming';
import { workflowOutputCopyStem } from '@shared/constants/workflowOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'CompareCommands';
const log = createLog(CHANNEL);

/**
 * A VS Code command this file dispatched and VS Code refused.
 *
 * `not-registered` is the host saying the id does not exist — the only way a
 * caller here tolerates a failure, and the only place the reading happens:
 * VS Code reports an unregistered id in the message text and nowhere else, so
 * the text is read once, beside the dispatch, and callers match `reason`.
 */
class VscodeCommandRefused extends Data.TaggedError('VscodeCommandRefused')<{
  readonly reason: 'not-registered' | 'failed';
  readonly commandId: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Dispatch one VS Code command, naming an unregistered id as its own reason. */
function executeVscodeCommand<T = void>(
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

/**
 * The host-neutral accept sequence, or the quick pick in front of it, faulted.
 * Both sides answer their ordinary outcomes as values — a cancelled pick is
 * `undefined`, a refused replace is `false` — so reaching here is a fault.
 *
 * `message` names the step and ends with the rejection's own text, because
 * the reporting tail shows `toErrorMessage` of this failure and the reason
 * the call gave is the part the user can act on.
 */
class AcceptEditedFailed extends Data.TaggedError('AcceptEditedFailed')<{
  readonly step: 'pick-target' | 'replace' | 'commit';
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Word one step's rejection as the failure the reporting tail shows. */
const acceptEditedFailure =
  (step: AcceptEditedFailed['step'], summary: string) => (cause: unknown) =>
    new AcceptEditedFailed({
      step,
      message: `${summary}: ${toErrorMessage(cause)}`,
      cause,
    });

/**
 * VS Code bindings for the host-neutral accept-edited sequence that the
 * filesystem cannot answer, shared by the replace and save-as-copy paths.
 * The reads and writes themselves are the sequence's own, against the
 * `FileSystem` the host entry's runtime carries.
 */
const acceptPorts: CommitAcceptedFilePorts = {
  emitWritten: (absolutePath) =>
    emitAppSignal('workspaceFilesWritten', {
      absolutePaths: [absolutePath],
    }),
  showInfo: (message) =>
    Effect.sync(() => {
      vscode.window.showInformationMessage(message);
      log.info(message);
    }),
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
  function* (baseLocation: FileLocation, editedLocation: FileLocation) {
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
          Effect.sync(() => {
            log.warn(
              `Could not check Progress view location: command '${contextKeyCommandId}' not found`,
            );
            return undefined;
          }),
      ),
    );

    if (location === 'secondarySideBar') {
      yield* executeVscodeCommand('workbench.action.closePanel');
    }

    yield* executeVscodeCommand('vscode.diff', editedUri, baseUri, title);

    yield* Effect.forkDetach(
      Effect.sleep(DIFF_REGISTRATION_DELAY_MS).pipe(
        Effect.andThen(
          Effect.sync(() => registerDiffRefresh(editedUri, baseUri, title)),
        ),
      ),
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

type ReplaceOrCopyTarget = {
  targetLocation: FileLocation;
  targetFileName: string;
};

/** Build the legacy `<base>_<agent>_r<round>_<model>` copy target beside the
 *  base file, preserving the base's location kind. */
function buildCopyTarget(
  baseLocation: FileLocation,
  copyMeta: AcceptCopyMeta,
): ReplaceOrCopyTarget {
  const parsed = path.parse(baseLocation.absolutePath);
  const stem = workflowOutputCopyStem({
    base: parsed.name,
    agent: copyMeta.agent,
    model: copyMeta.model,
    round: copyMeta.round,
  });
  const targetFileName = `${stem}${parsed.ext}`;
  return {
    targetLocation: siblingLocation(baseLocation, targetFileName),
    targetFileName,
  };
}

/** Offer a quick-pick between replacing the original and saving a postfixed
 *  copy, used when run metadata is available. Returns undefined when the user
 *  cancels. */
async function pickReplaceOrCopyTarget(
  baseLocation: FileLocation,
  editedPath: string,
  copyMeta: AcceptCopyMeta,
): Promise<ReplaceOrCopyTarget | undefined> {
  const replaceTarget = getAcceptedFileTarget(baseLocation, editedPath);
  const copyTarget = buildCopyTarget(baseLocation, copyMeta);
  type AcceptItem = vscode.QuickPickItem & {
    target: ReplaceOrCopyTarget;
  };
  const acceptItems: AcceptItem[] = [
    {
      label: '$(replace) Replace original',
      description: replaceTarget.targetFileName,
      target: replaceTarget,
    },
    {
      label: '$(files) Save as copy',
      description: copyTarget.targetFileName,
      target: copyTarget,
    },
  ];

  const pick = await vscode.window.showQuickPick<AcceptItem>(acceptItems, {
    title: 'Accept edits',
    placeHolder: `Accept '${path.basename(editedPath)}' into the workspace`,
    ignoreFocusOut: true,
    prompt: `Edited file: ${path.basename(editedPath)}`,
  });
  return pick?.target;
}

export const handleAcceptEdited = Effect.fn(
  'compareCommands.handleAcceptEdited',
)(
  function* (
    baseLocation: FileLocation,
    editedLocation: FileLocation,
    copyMeta?: AcceptCopyMeta,
  ) {
    if (!(yield* validateFilesExist(baseLocation, editedLocation))) {
      return false;
    }
    const fs = yield* FileSystem.FileSystem;

    // No run metadata: single-confirm replace flow shared with the desktop host.
    if (!copyMeta) {
      const replaceFailed = acceptEditedFailure(
        'replace',
        'The edited file could not replace the original',
      );
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
    }

    // Run metadata present: let the user replace the original or save a
    // postfixed copy, then commit the chosen target.
    const resolved = yield* Effect.tryPromise({
      try: () =>
        pickReplaceOrCopyTarget(
          baseLocation,
          editedLocation.absolutePath,
          copyMeta,
        ),
      catch: acceptEditedFailure(
        'pick-target',
        'The accept target could not be chosen',
      ),
    });
    if (!resolved) return false;

    const targetExisted = yield* fs.exists(
      resolved.targetLocation.absolutePath,
    );

    yield* commitAcceptedFile(
      baseLocation,
      editedLocation,
      resolved,
      targetExisted,
      acceptPorts,
    ).pipe(
      Effect.mapError(
        acceptEditedFailure(
          'commit',
          'The accepted file could not be committed',
        ),
      ),
    );
    return true;
  },
  Effect.catchCause((cause) =>
    showLoggedErrorMessage(
      CHANNEL,
      'Error accepting changes',
      Cause.squash(cause),
    ).pipe(Effect.as(false)),
  ),
);
