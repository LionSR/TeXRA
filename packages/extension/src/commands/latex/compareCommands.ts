// Node imports
import * as path from 'node:path';

// Third-party imports
import { Cause, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { hostPort } from '@common/hostPort';
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
  if (!(yield* fs.exists(baseLocation.absolutePath))) {
    void showLoggedMessage(
      CHANNEL,
      `Base file not found: ${baseLocation.absolutePath}`,
    );
    return false;
  }

  if (!(yield* fs.exists(editedLocation.absolutePath))) {
    void showLoggedMessage(
      CHANNEL,
      `Edited file not found: ${editedLocation.absolutePath}`,
    );
    return false;
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
    yield* hostPort(async () => {
      const location: string | undefined = await vscode.commands.executeCommand(
        contextKeyCommandId,
        'viewContainerLocation:texra',
      );

      if (location === 'secondarySideBar') {
        await vscode.commands.executeCommand('workbench.action.closePanel');
      }
    }).pipe(
      // A host without the context-key command cannot report where the view
      // lives; the diff still opens. Every other failure fails the compare.
      Effect.catchIf(
        (error) =>
          toErrorMessage(error).includes(
            `command '${contextKeyCommandId}' not found`,
          ),
        () =>
          Effect.sync(() => {
            log.warn(
              `Could not check Progress view location: command '${contextKeyCommandId}' not found`,
            );
          }),
      ),
    );

    yield* hostPort(() =>
      vscode.commands.executeCommand('vscode.diff', editedUri, baseUri, title),
    );

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
      return yield* hostPort(() =>
        acceptEditedFileReplace(baseLocation, editedLocation, {
          ...ports,
          confirm: (message) => confirmModal(message, 'Replace file', 'Cancel'),
        }),
      );
    }

    // Run metadata present: let the user replace the original or save a
    // postfixed copy, then commit the chosen target.
    const resolved = yield* hostPort(() =>
      pickReplaceOrCopyTarget(
        baseLocation,
        editedLocation.absolutePath,
        copyMeta,
      ),
    );
    if (!resolved) return false;

    const targetExisted = yield* fs.exists(
      resolved.targetLocation.absolutePath,
    );

    yield* hostPort(() =>
      commitAcceptedFile(
        baseLocation,
        editedLocation,
        resolved,
        targetExisted,
        ports,
      ),
    );
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
