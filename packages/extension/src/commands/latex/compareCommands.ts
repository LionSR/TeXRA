// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import {
  showLoggedErrorMessage,
  toErrorMessage,
} from '@frontend/ui/errorHandlingUtils';
import { registerDiffRefresh } from '@frontend/ui/diffView';
import { legacyWorkflowOutputStem } from '@agent/output/workflowOutputLayout';
import { getAcceptedFileTarget } from '@latex/acceptedFileTarget';
import * as logger from '@logger/logUtils';
import { DIFF_REGISTRATION_DELAY_MS } from '@shared/constants/latex';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
  flexibleFS,
} from '@utils/files';
import type { FileLocation } from '@utils/files';

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
    vscode.window.showErrorMessage(errorMessage);
    return null;
  }
  return fileToUseLocation;
}

async function validateFilesExist(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
): Promise<boolean> {
  if (!(await flexibleFS.exists(baseLocation))) {
    vscode.window.showErrorMessage(
      `Base file not found: ${baseLocation.absolutePath}`,
    );
    return false;
  }

  if (!(await flexibleFS.exists(editedLocation))) {
    vscode.window.showErrorMessage(
      `Edited file not found: ${editedLocation.absolutePath}`,
    );
    return false;
  }

  return true;
}

export function registerCompareCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.compare', handleCompare),
    vscode.commands.registerCommand('texra.acceptEdited', handleAcceptEdited),
  );
}

async function handleCompare(
  inputLocation: FileLocation,
  baseLocation: FileLocation,
  editedLocation: FileLocation,
) {
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
  const ext = path.extname(baseLocation.absolutePath);
  const stem = legacyWorkflowOutputStem({
    base: path.parse(baseLocation.absolutePath).name,
    agent: copyMeta.agent,
    model: copyMeta.model,
    round: copyMeta.round,
  });
  const targetFileName = `${stem}${ext}`;
  const targetAbsolute = path.join(
    path.dirname(baseLocation.absolutePath),
    targetFileName,
  );

  if (baseLocation.kind === 'external') {
    return {
      targetLocation: createExternalLocation(targetAbsolute),
      targetFileName,
    };
  }

  const targetRelative = path.join(
    path.dirname(baseLocation.relativePath),
    targetFileName,
  );
  const targetLocation =
    baseLocation.kind === 'workspace'
      ? createWorkspaceLocation(targetAbsolute, targetRelative)
      : createRunStorageLocation(
          targetAbsolute,
          targetRelative,
          baseLocation.executionId,
        );
  return { targetLocation, targetFileName };
}

/** Original single-confirm flow used when no run metadata is available. */
async function confirmReplace(
  target: ReturnType<typeof getAcceptedFileTarget>,
  basePath: string,
  editedPath: string,
): Promise<boolean> {
  const { targetLocation, targetFileName, isNewFile } = target;
  const targetExists = isNewFile && (await flexibleFS.exists(targetLocation));
  const baseExt = path.extname(basePath).toLowerCase();
  const editedExt = path.extname(editedPath).toLowerCase();

  const action = targetExists
    ? 'overwrite existing'
    : isNewFile
      ? 'create'
      : 'overwrite';
  const extensionNote = isNewFile
    ? `Extensions differ (${baseExt} vs ${editedExt}). `
    : '';
  const confirmMessage = `${extensionNote}This will ${action} '${targetFileName}' with content from '${path.basename(editedPath)}'. Are you sure?`;

  const answer = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    'Yes',
    'Cancel',
  );
  return answer === 'Yes';
}

/** Resolve which target to write: a quick-pick (replace vs postfixed copy)
 *  when run metadata is available, otherwise the legacy confirm dialog.
 *  Returns undefined when the user cancels. */
async function resolveAcceptTarget(
  baseLocation: FileLocation,
  editedPath: string,
  copyMeta: AcceptCopyMeta | undefined,
): Promise<
  { targetLocation: FileLocation; targetFileName: string } | undefined
> {
  const replaceTarget = getAcceptedFileTarget(baseLocation, editedPath);

  if (!copyMeta) {
    const confirmed = await confirmReplace(
      replaceTarget,
      baseLocation.absolutePath,
      editedPath,
    );
    return confirmed ? replaceTarget : undefined;
  }

  const copyTarget = buildCopyTarget(baseLocation, copyMeta);
  const pick = await vscode.window.showQuickPick(
    [
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
    ],
    {
      title: 'Accept edits',
      placeHolder: `Accept '${path.basename(editedPath)}' into the workspace`,
      ignoreFocusOut: true,
    },
  );
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

    const editedPath = editedLocation.absolutePath;
    const editedFileName = path.basename(editedPath);

    const resolved = await resolveAcceptTarget(
      fileToUseLocation,
      editedPath,
      copyMeta,
    );
    if (!resolved) return false;

    const { targetLocation, targetFileName } = resolved;
    const operation = (await flexibleFS.exists(targetLocation))
      ? 'replaced'
      : 'created';

    const editedContent = await flexibleFS.read(editedLocation);
    await flexibleFS.write(targetLocation, editedContent);

    if (targetLocation.kind === 'workspace') {
      bus.emit('workspaceFilesWritten', {
        absolutePaths: [targetLocation.absolutePath],
      });
    }

    const successMessage = `Successfully ${operation} '${targetFileName}' with content from '${editedFileName}'`;
    vscode.window.showInformationMessage(successMessage);
    logger.info(CHANNEL, successMessage);
    return true;
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error accepting changes', err);
    return false;
  }
}
