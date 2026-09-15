// Node imports
import * as path from 'node:path';

// Third-party imports
import { Cause, Data, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { appSignals } from '@eventBus/AppSignals';
import { confirmModal } from '@frontend/ui/dialogs';
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
  type AcceptEditedFileReplacePorts,
  type CommitAcceptedFilePorts,
} from '@latex/acceptedFileTarget';
import { createLog } from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { AcceptCopyMeta, FileLocation } from '@shared/schemas';
import { DIFF_REGISTRATION_DELAY_MS } from '@shared/constants/latexTiming';
import { workflowOutputCopyStem } from '@shared/constants/workflowOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

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

/**
 * VS Code bindings for the host-neutral accept-edited sequence, shared by
 * the replace and save-as-copy paths. A location's absolute path is where its
 * file is, so every read and write goes through the process filesystem the
 * command runs with, at that path, settled on the host entry's runtime.
 */
function acceptPorts(
  fs: FileSystem.FileSystem,
  runtime: ProcessRuntime,
): CommitAcceptedFilePorts & Pick<AcceptEditedFileReplacePorts, 'exists'> {
  return {
    readFile: (location) =>
      runtime.runPromise(
        fs
          .readFileString(location.absolutePath)
          .pipe(Effect.map(normalizeLineEndings)),
      ),
    writeFile: (location, content) =>
      runtime.runPromise(fs.writeFileString(location.absolutePath, content)),
    exists: (location) => runtime.runPromise(fs.exists(location.absolutePath)),
    emitWritten: (absolutePath) =>
      appSignals.emit('workspaceFilesWritten', {
        absolutePaths: [absolutePath],
      }),
    showInfo: (message) => {
      vscode.window.showInformationMessage(message);
      log.info(message);
    },
    // Diff-file cleanup is a best-effort side effect of accepting a file: a
    // file already gone is the post-condition, and any other failure (a
    // locked file) is reported without failing the accept.
    deleteFile: (location) =>
      runtime.runPromise(
        fs.remove(location.absolutePath, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn(
                `Could not remove the stale diff file ${location.absolutePath}: ${error.message}`,
              );
            }),
          ),
        ),
      ),
  };
}

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
      void showLoggedMessage(
        CHANNEL,
        `${label} file not found: ${location.absolutePath}`,
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

    setTimeout(() => {
      registerDiffRefresh(editedUri, baseUri, title);
    }, DIFF_REGISTRATION_DELAY_MS);

    log.info(
      `Opened diff comparison between ${baseFileName} and ${editedFileName}`,
    );
  },
  Effect.catchCause((cause) =>
    Effect.promise(async () => {
      await showLoggedErrorMessage(
        CHANNEL,
        'Error comparing files',
        Cause.squash(cause),
      );
    }),
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
    runtime: ProcessRuntime,
    copyMeta?: AcceptCopyMeta,
  ) {
    if (!(yield* validateFilesExist(baseLocation, editedLocation))) {
      return false;
    }
    const fs = yield* FileSystem.FileSystem;
    const ports = acceptPorts(fs, runtime);

    // No run metadata: single-confirm replace flow shared with the desktop host.
    if (!copyMeta) {
      return yield* Effect.tryPromise({
        try: () =>
          acceptEditedFileReplace(baseLocation, editedLocation, {
            ...ports,
            confirm: (message) =>
              confirmModal(message, 'Replace file', 'Cancel'),
          }),
        catch: (cause) =>
          new AcceptEditedFailed({
            step: 'replace',
            message: `The edited file could not replace the original: ${toErrorMessage(cause)}`,
            cause,
          }),
      });
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
      catch: (cause) =>
        new AcceptEditedFailed({
          step: 'pick-target',
          message: `The accept target could not be chosen: ${toErrorMessage(cause)}`,
          cause,
        }),
    });
    if (!resolved) return false;

    const targetExisted = yield* fs.exists(
      resolved.targetLocation.absolutePath,
    );

    yield* Effect.tryPromise({
      try: () =>
        commitAcceptedFile(
          baseLocation,
          editedLocation,
          resolved,
          targetExisted,
          ports,
        ),
      catch: (cause) =>
        new AcceptEditedFailed({
          step: 'commit',
          message: `The accepted file could not be committed: ${toErrorMessage(cause)}`,
          cause,
        }),
    });
    return true;
  },
  Effect.catchCause((cause) =>
    Effect.promise(async () => {
      await showLoggedErrorMessage(
        CHANNEL,
        'Error accepting changes',
        Cause.squash(cause),
      );
      return false;
    }),
  ),
);
