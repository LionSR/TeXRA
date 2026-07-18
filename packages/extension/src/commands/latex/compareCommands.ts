// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { registerCommands } from '@commands/_shared/registerCommands';
import { appSignals } from '@eventBus/AppSignals';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
  toErrorMessage,
} from '@frontend/ui/errorHandlingUtils';
import { registerDiffRefresh } from '@frontend/ui/diffView';
import {
  acceptEditedFileReplace,
  buildAcceptSuccessMessage,
  cleanupStaleDiffFile,
  getAcceptedFileTarget,
  siblingLocation,
} from '@latex/acceptedFileTarget';
import * as logger from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { DIFF_REGISTRATION_DELAY_MS } from '@shared/constants/latex';
import { legacyWorkflowOutputStem } from '@shared/constants/legacyWorkflowOutput';
import { FlexibleFS } from '@utils/files';

/** Run agent/model/round used to build the legacy postfixed copy name. */
type AcceptCopyMeta = { agent: string; model: string; round: number };

const CHANNEL = 'CompareCommands';
logger.initialize(CHANNEL);

function validateFileLocations(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
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
    await FlexibleFS.delete(location);
  } catch {
    // Non-fatal: diff file may not exist or may be locked.
  }
}

async function validateFilesExist(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
): Promise<boolean> {
  if (!(await FlexibleFS.exists(baseLocation))) {
    void showLoggedMessage(
      CHANNEL,
      `Base file not found: ${baseLocation.absolutePath}`,
    );
    return false;
  }

  if (!(await FlexibleFS.exists(editedLocation))) {
    void showLoggedMessage(
      CHANNEL,
      `Edited file not found: ${editedLocation.absolutePath}`,
    );
    return false;
  }

  return true;
}

export function registerCompareCommands(
  context: vscode.ExtensionContext,
): void {
  registerCommands(context, [
    { id: 'texra.compare', handler: handleCompare },
    { id: 'texra.acceptEdited', handler: handleAcceptEdited },
  ]);
}

async function handleCompare(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
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
          `Could not check ProgressBoard location: command '${contextKeyCommandId}' not found`,
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

/** Build the legacy `<base>_<agent>_r<round>_<model>` copy target beside the
 *  base file, preserving the base's location kind. */
function buildCopyTarget(
  baseLocation: FileLocation,
  copyMeta: AcceptCopyMeta,
): { targetLocation: FileLocation; targetFileName: string } {
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

type ReplaceOrCopyTarget = {
  targetLocation: FileLocation;
  targetFileName: string;
};

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

async function handleAcceptEdited(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
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
        exists: (location) => FlexibleFS.exists(location),
        readFile: (location) => FlexibleFS.read(location),
        writeFile: (location, content) => FlexibleFS.write(location, content),
        confirm: async (message) => {
          const answer = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Yes',
            'Cancel',
          );
          return answer === 'Yes';
        },
        emitWritten: (absolutePath) =>
          appSignals.emit('workspaceFilesWritten', {
            absolutePaths: [absolutePath],
          }),
        showInfo: (message) => {
          vscode.window.showInformationMessage(message);
          logger.info(CHANNEL, message);
        },
        deleteFile: deleteDiffFileNonFatal,
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

    const { targetLocation, targetFileName } = resolved;
    const targetExisted = await FlexibleFS.exists(targetLocation);

    const editedContent = await FlexibleFS.read(editedLocation);
    await FlexibleFS.write(targetLocation, editedContent);

    if (targetLocation.kind === 'workspace') {
      appSignals.emit('workspaceFilesWritten', {
        absolutePaths: [targetLocation.absolutePath],
      });
    }

    // No-ops unless targetLocation is fileToUseLocation itself: "save as
    // copy" and an extension-mismatched "replace" both leave the base (and
    // its diff) untouched, so cleanup would delete a still-meaningful diff.
    await cleanupStaleDiffFile(
      fileToUseLocation,
      editedLocation.absolutePath,
      targetLocation,
      deleteDiffFileNonFatal,
    );

    const successMessage = buildAcceptSuccessMessage(
      targetFileName,
      editedLocation.absolutePath,
      targetExisted,
    );
    vscode.window.showInformationMessage(successMessage);
    logger.info(CHANNEL, successMessage);
    return true;
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error accepting changes', err);
    return false;
  }
}
