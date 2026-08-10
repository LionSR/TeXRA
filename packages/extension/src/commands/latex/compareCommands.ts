// Node imports
import * as path from 'node:path';

// Third-party imports
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
  type CommitAcceptedFilePorts,
} from '@latex/acceptedFileTarget';
import * as logger from '@logger/logUtils';
import type { AcceptCopyMeta, FileLocation } from '@shared/schemas';
import { DIFF_REGISTRATION_DELAY_MS } from '@shared/constants/latex';
import { legacyWorkflowOutputStem } from '@shared/constants/workflowOutput';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'CompareCommands';

function validateFileLocations(
  inputLocation: FileLocation | null | undefined,
  baseLocation: FileLocation | null | undefined,
  editedLocation: FileLocation,
  errorMessage: string,
): FileLocation | null {
  const fileToUseLocation = baseLocation ?? inputLocation;
  if (!fileToUseLocation || !editedLocation) {
    void showLoggedMessage(CHANNEL, errorMessage);
    return null;
  }
  return fileToUseLocation;
}

/** Delete a workspace file, swallowing errors (already gone, locked) since
 *  diff-file cleanup is a best-effort side effect of accepting a file. */
async function deleteDiffFileNonFatal(location: FileLocation): Promise<void> {
  try {
    await AbsoluteFS.delete(location.absolutePath);
  } catch {
    // Non-fatal: diff file may not exist or may be locked.
  }
}

/** VS Code bindings for the host-neutral accept-edited commit sequence,
 *  shared by the replace and save-as-copy paths. */
const COMMIT_PORTS: CommitAcceptedFilePorts = {
  readFile: (location) => AbsoluteFS.read(location.absolutePath),
  writeFile: (location, content) =>
    AbsoluteFS.write(location.absolutePath, content),
  emitWritten: (absolutePath) =>
    appSignals.emit('workspaceFilesWritten', { absolutePaths: [absolutePath] }),
  showInfo: (message) => {
    vscode.window.showInformationMessage(message);
    logger.info(CHANNEL, message);
  },
  deleteFile: deleteDiffFileNonFatal,
};

async function validateFilesExist(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
): Promise<boolean> {
  if (!(await AbsoluteFS.exists(baseLocation.absolutePath))) {
    void showLoggedMessage(
      CHANNEL,
      `Base file not found: ${baseLocation.absolutePath}`,
    );
    return false;
  }

  if (!(await AbsoluteFS.exists(editedLocation.absolutePath))) {
    void showLoggedMessage(
      CHANNEL,
      `Edited file not found: ${editedLocation.absolutePath}`,
    );
    return false;
  }

  return true;
}

export async function handleCompare(
  inputLocation: FileLocation | null | undefined,
  baseLocation: FileLocation | null | undefined,
  editedLocation: FileLocation,
): Promise<void> {
  try {
    const fileToUseLocation = validateFileLocations(
      inputLocation,
      baseLocation,
      editedLocation,
      'Both base file and edited file must be selected for comparison',
    );
    if (!fileToUseLocation) return;

    if (!(await validateFilesExist(fileToUseLocation, editedLocation))) {
      return;
    }

    const baseUri = vscode.Uri.file(fileToUseLocation.absolutePath);
    const editedUri = vscode.Uri.file(editedLocation.absolutePath);
    const baseFileName = path.basename(fileToUseLocation.absolutePath);
    const editedFileName = path.basename(editedLocation.absolutePath);
    const title = `Compare: ${editedFileName} ↔ ${baseFileName}`;

    const contextKeyCommandId = 'vscode.getContextKeyValue';
    try {
      const location: string | undefined = await vscode.commands.executeCommand(
        contextKeyCommandId,
        'viewContainerLocation:texra',
      );

      if (location === 'secondarySideBar') {
        await vscode.commands.executeCommand('workbench.action.closePanel');
      }
    } catch (err) {
      const message = toErrorMessage(err);
      if (message.includes(`command '${contextKeyCommandId}' not found`)) {
        logger.warn(
          CHANNEL,
          `Could not check Progress view location: command '${contextKeyCommandId}' not found`,
        );
      } else {
        throw err;
      }
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      editedUri,
      baseUri,
      title,
    );

    setTimeout(() => {
      registerDiffRefresh(editedUri, baseUri, title);
    }, DIFF_REGISTRATION_DELAY_MS);

    logger.info(
      CHANNEL,
      `Opened diff comparison between ${baseFileName} and ${editedFileName}`,
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error comparing files', err);
  }
}

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
  const stem = legacyWorkflowOutputStem({
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

export async function handleAcceptEdited(
  inputLocation: FileLocation | null | undefined,
  baseLocation: FileLocation | null | undefined,
  editedLocation: FileLocation,
  copyMeta?: AcceptCopyMeta,
): Promise<boolean> {
  try {
    const fileToUseLocation = validateFileLocations(
      inputLocation,
      baseLocation,
      editedLocation,
      'Both base file and edited file must be selected to accept changes',
    );
    if (!fileToUseLocation) return false;

    if (!(await validateFilesExist(fileToUseLocation, editedLocation))) {
      return false;
    }

    // No run metadata: single-confirm replace flow shared with the desktop host.
    if (!copyMeta) {
      return await acceptEditedFileReplace(fileToUseLocation, editedLocation, {
        ...COMMIT_PORTS,
        exists: (location) => AbsoluteFS.exists(location.absolutePath),
        confirm: (message) => confirmModal(message, 'Replace file', 'Cancel'),
      });
    }

    // Run metadata present: let the user replace the original or save a
    // postfixed copy, then commit the chosen target.
    const resolved = await pickReplaceOrCopyTarget(
      fileToUseLocation,
      editedLocation.absolutePath,
      copyMeta,
    );
    if (!resolved) return false;

    const targetExisted = await AbsoluteFS.exists(
      resolved.targetLocation.absolutePath,
    );

    await commitAcceptedFile(
      fileToUseLocation,
      editedLocation,
      resolved,
      targetExisted,
      COMMIT_PORTS,
    );
    return true;
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error accepting changes', err);
    return false;
  }
}
