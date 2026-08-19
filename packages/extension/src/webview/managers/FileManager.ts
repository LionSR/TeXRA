import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vscode from 'vscode';

import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import {
  MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES,
  normalizeMainViewFileExtension,
  planMainViewDroppedFileAttachments,
} from '@controllers/mainView/MainViewDroppedFilesController';
import { getFileLister } from '@frontend/files/fileLister';
import {
  FILE_SELECTION_COMMAND_IDS,
  MULTIPLE_FILE_COMMANDS,
} from '@frontend/files/fileSelectionRegistry';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { parseVersionControlDiffFilename } from '@latex/latexdiff/diffFileNameManager';
import { createLog } from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { DocumentFileType, MainViewInboundMessage } from '@shared/schemas';
import { isMultipleDocumentFileType } from '@shared/schemas';
import { getFileStem } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

import { BaseWebviewManager } from './BaseWebviewManager';

type MessageFor<C extends MainViewInboundMessage['command']> = Extract<
  MainViewInboundMessage,
  { command: C }
>;

type RequestEditedFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE
>;

type RequestBaseFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE
>;

type SelectMultipleFilesMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES
>;

type AttachDroppedFilesMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.ATTACH_DROPPED_FILES
>;

type GetCurrentFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.GET_CURRENT_FILE
>;

const CHANNEL = 'FileManager';
const log = createLog(CHANNEL);

export class FileManager extends BaseWebviewManager {
  async handleRequestEditedFile(
    message: RequestEditedFileMessage,
  ): Promise<void> {
    const files = message.baseFile
      ? await getFileLister().listEditedFiles(getFileStem(message.baseFile))
      : [];
    if (message.notifyWhenEmpty && files.length === 0) {
      log.debug('No edited files were found during refresh.');
    }
    this.postMessage({ command: MAIN_VIEW_COMMANDS.SET_EDITED_FILE, files });
  }

  async handleRequestBaseFile(message: RequestBaseFileMessage): Promise<void> {
    const files = await getFileLister().list('input');
    this.postBaseFiles(files, {
      notifyWhenEmpty: Boolean(message.notifyWhenEmpty),
      preserveBaseFile: message.preserveBaseFile,
    });
    this.postGettingStartedBanner(files.length === 0);
  }

  async handleSelectMultipleFiles(
    message: SelectMultipleFilesMessage,
  ): Promise<void> {
    const { fileType, currentFile } = message;
    const commands = isMultipleDocumentFileType(fileType)
      ? MULTIPLE_FILE_COMMANDS.get(fileType)
      : undefined;
    if (!commands) {
      log.warn(`Unsupported multiple file selection: ${fileType}`);
      return;
    }
    try {
      const selectedFiles = await vscode.commands.executeCommand<string[]>(
        commands.selectCommand,
        currentFile,
      );

      if (selectedFiles) {
        this.postMessage({
          command: commands.responseCommand,
          files: selectedFiles,
        });
      }
    } catch (error) {
      await showLoggedErrorMessage(
        CHANNEL,
        `Error selecting ${fileType}`,
        error,
      );
    }
  }

  // Multi-list categories are user-owned (only mutated through the picker /
  // drag-drop / Add opened) so we don't push disk listings into them — just
  // refresh the still-single-slot base-file dropdown and the empty-workspace banner.
  async handleRefreshAllFiles(): Promise<void> {
    const inputFiles = await getFileLister().list('input');
    this.postBaseFiles(inputFiles, { preserveBaseFile: true });
    this.postGettingStartedBanner(inputFiles.length === 0);
  }

  async handleGetCurrentFile(message: GetCurrentFileMessage): Promise<void> {
    const fileType = message.fileType ?? 'input';
    const currentOpenFile = await vscode.commands.executeCommand<string>(
      FILE_SELECTION_COMMAND_IDS.getCurrentFile,
    );

    if (!currentOpenFile) {
      vscode.window.showInformationMessage(
        'No file is currently open or the file is not part of the workspace.',
      );
      return;
    }

    // An edited file is valid when its basename starts with the base file's
    // basename without being identical to it (`paper-revised.tex` is a valid
    // edited version of `paper.tex`). Neither rejection selects anything.
    if (fileType === 'edited') {
      const baseFile = message.baseFile;
      if (!baseFile) {
        vscode.window.showInformationMessage('Choose a base file first.');
        return;
      }
      const baseFileStem = path.basename(baseFile, path.extname(baseFile));
      const currentFileStem = path.basename(
        currentOpenFile,
        path.extname(currentOpenFile),
      );
      if (
        !currentFileStem.startsWith(baseFileStem) ||
        currentFileStem === baseFileStem
      ) {
        vscode.window.showInformationMessage(
          'The current file is not a valid edited version of the base file.',
        );
        return;
      }
    }

    // Opening a latexdiff artifact (`paper-diff1234abcd.tex`) as the base file
    // selects the file it was derived from instead, when that file is still on
    // disk. The dropdown is refreshed first so the derived path already exists
    // as an option by the time SET_CURRENT_FILE names it.
    if (fileType === 'base') {
      const derivedBaseFile =
        parseVersionControlDiffFilename(currentOpenFile)?.sourcePath;
      if (derivedBaseFile) {
        if (await WorkspaceFS.exists(derivedBaseFile)) {
          await this.handleRequestBaseFile({
            command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
            preserveBaseFile: true,
          });
          this.postMessage({
            command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
            filePath: derivedBaseFile,
            fileType,
          });
          await this.maybeSelectCommitFromDiffFile(currentOpenFile);
          return;
        }
        log.info(
          `Derived base file ${derivedBaseFile} from ${currentOpenFile} does not exist on disk`,
        );
        vscode.window.showInformationMessage(
          `The base file ${derivedBaseFile} could not be found. Keeping ${currentOpenFile} selected.`,
        );
      }
    }

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
      filePath: currentOpenFile,
      fileType,
    });

    await this.maybeSelectCommitFromDiffFile(currentOpenFile);
  }

  private async maybeSelectCommitFromDiffFile(filePath: string): Promise<void> {
    const parsed = parseVersionControlDiffFilename(filePath);
    if (!parsed) {
      return;
    }

    const fileName = path.basename(filePath);
    const { commitHash } = parsed;
    const commitLabel = await vscode.commands.executeCommand<string | null>(
      'texra.findCommitInHistory',
      commitHash,
    );

    if (commitLabel) {
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT,
        commitHash,
        commitLabel,
      });
    } else {
      log.info(
        `Commit ${commitHash} from ${fileName} was not found in repository history`,
      );
      vscode.window.showInformationMessage(
        `The commit ${commitHash} referenced by ${fileName} was not found in the repository history.`,
      );
    }
  }

  async handleAddOpenedFiles(fileType: DocumentFileType): Promise<void> {
    const openedFiles = this.getOpenedFiles();
    const allowedExtensions = new Set(
      getIncludedExtensions(fileType).map(normalizeMainViewFileExtension),
    );

    const filteredFiles =
      allowedExtensions.size > 0
        ? openedFiles.filter((file) =>
            allowedExtensions.has(normalizeMainViewFileExtension(file)),
          )
        : openedFiles;

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_OPENED_FILES,
      files: filteredFiles,
      fileType,
    });
  }

  async handleAttachDroppedFiles(
    message: AttachDroppedFilesMessage,
  ): Promise<void> {
    const paths = await Promise.all(
      message.paths.map((rawPath) => this.resolveWorkspaceDropFile(rawPath)),
    );
    const plan = planMainViewDroppedFileAttachments({
      paths,
      allowedExtensions: {
        input: getIncludedExtensions('input'),
        context: getIncludedExtensions('context'),
        media: getIncludedExtensions('media'),
      },
      target: message.target ?? undefined,
    });

    for (const fileType of MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES) {
      const droppedFiles = plan.filesByCategory[fileType];
      if (droppedFiles.length === 0) continue;
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_OPENED_FILES,
        files: [...droppedFiles],
        fileType,
      });
    }

    this.showDroppedFilesResult(plan.attachedCount, plan.rejectedCount);
  }

  private postBaseFiles(
    files: string[],
    options: { notifyWhenEmpty?: boolean; preserveBaseFile?: boolean } = {},
  ): void {
    if (options.notifyWhenEmpty && files.length === 0) {
      log.debug('No base files were found during refresh.');
    }
    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
      files,
      ...(options.preserveBaseFile ? { preserveBaseFile: true } : {}),
    });
  }

  /** Post show/hide getting started banner. */
  private postGettingStartedBanner(show: boolean): void {
    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_BANNER,
      banner: 'gettingStarted',
      visible: show,
    });
  }

  private getOpenedFiles(): string[] {
    if (!WorkspaceFS.getPath()) {
      log.warn('No workspace path found for opened files');
      return [];
    }

    const fileUris = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.input)
      .filter(
        (input): input is vscode.TabInputText | vscode.TabInputCustom =>
          input instanceof vscode.TabInputText ||
          input instanceof vscode.TabInputCustom,
      )
      .map((input) => input.uri)
      .filter((uri) => uri.scheme === 'file');

    const relevantFiles = [
      ...new Set(fileUris.map((uri) => WorkspaceFS.relativePath(uri.fsPath))),
    ];

    log.debug(`Found opened files: ${relevantFiles.join(', ')}`);
    return relevantFiles;
  }

  private async resolveWorkspaceDropFile(
    rawPath: string,
  ): Promise<string | null> {
    const decodedPath = this.decodeDroppedPath(rawPath);
    const resolved = WorkspaceFS.locatePath(decodedPath);
    if (resolved.kind !== 'workspace') return null;

    try {
      const stat = await vscode.workspace.fs.stat(
        vscode.Uri.file(resolved.absolutePath),
      );
      if ((stat.type & vscode.FileType.File) === 0) return null;
      return resolved.relativePath;
    } catch (error) {
      log.debug(
        `Dropped file could not be read: ${decodedPath}: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  private decodeDroppedPath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed.startsWith('file:')) return trimmed;
    try {
      return fileURLToPath(trimmed);
    } catch {
      return trimmed;
    }
  }

  private showDroppedFilesResult(
    attachedCount: number,
    rejectedCount: number,
  ): void {
    if (attachedCount > 0 && rejectedCount === 0) return;
    if (attachedCount > 0) {
      vscode.window.showInformationMessage(
        `Attached ${formatResultCount(attachedCount, 'dropped file')}; skipped ${formatResultCount(rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
      );
      return;
    }
    if (rejectedCount > 0) {
      vscode.window.showInformationMessage(
        'No dropped files were attached. Use regular files inside this workspace with supported TeXRA extensions.',
      );
    }
  }
}
