import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vscode from 'vscode';

import { ExtensionCategory, getIncludedExtensions } from '@common/files';
import {
  planCurrentFileAsBase,
  planCurrentFileAsEdited,
  type MainViewBaseFileSelectionPlan,
} from '@controllers/mainView/MainViewBaseFileController';
import {
  MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES,
  normalizeMainViewFileExtension,
  planMainViewDroppedFileAttachments,
  type MainViewAllowedDropExtensions,
} from '@controllers/mainView/MainViewDroppedFilesController';
import {
  FILE_SELECTION_COMMAND_IDS,
  MULTIPLE_FILE_COMMANDS,
  getFileLister,
} from '@frontend/files';
import { selectFiles } from '@frontend/ui/dialogs';
import {
  showLoggedErrorMessage,
  toErrorMessage,
} from '@frontend/ui/errorHandlingUtils';
import { detectGeneratedLatexdiffArtifact } from '@latex/latexdiff/diffFileNameManager';
import * as logger from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundMessage } from '@shared/schemas';
import {
  isMultipleDocumentFileType,
  type CurrentFileType,
  type ExtendedDocumentFileType,
} from '@shared/schemas/fileTypes';
import { WorkspaceFS } from '@utils/files';

import { getConfig } from '@utils/config';
import { getFileStem } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

import { BaseWebviewManager } from './BaseWebviewManager';

type MessageFor<C extends MainViewInboundMessage['command']> = Extract<
  MainViewInboundMessage,
  { command: C }
>;

type EditedFileSelectionMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE
>;

type EditedFileSelectedMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED
>;

type RequestEditedFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE
>;

type RequestBaseFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE
>;

type SetMultipleFilesMessage = MessageFor<
  | typeof MAIN_VIEW_COMMANDS.SET_INPUT_FILES
  | typeof MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES
  | typeof MAIN_VIEW_COMMANDS.SET_MEDIA_FILES
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

type UpdateFilesMessage = MessageFor<
  | typeof MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES
  | typeof MAIN_VIEW_COMMANDS.UPDATE_CONTEXT_FILES
  | typeof MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES
  | typeof MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES
>;

const CHANNEL = 'FileManager';

type FileUpdateOptions = {
  notifyWhenEmpty?: boolean;
  /** Only meaningful for `fileType: 'Base'` — see `SET_BASE_FILE`. */
  preserveBaseFile?: boolean;
};

export class FileManager extends BaseWebviewManager {
  protected readonly channel = CHANNEL;

  async handleEditedFileSelection(
    _message?: EditedFileSelectionMessage,
  ): Promise<void> {
    const editedFile = await vscode.commands.executeCommand<string>(
      FILE_SELECTION_COMMAND_IDS.selectEditedFile,
    );
    if (editedFile) {
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED,
        filePath: editedFile,
      });
    }
  }

  handleGenericFileSelected(message: EditedFileSelectedMessage): void {
    logger.debug(CHANNEL, `${message.command}: ${message.filePath}`);
  }

  async handleRequestEditedFile(
    message: RequestEditedFileMessage,
  ): Promise<void> {
    const files = message.baseFile
      ? await getFileLister().listEditedFiles(getFileStem(message.baseFile))
      : [];
    this.postFileUpdate('Edited', files, {
      notifyWhenEmpty: Boolean(message.notifyWhenEmpty),
    });
  }

  async handleRequestBaseFile(message: RequestBaseFileMessage): Promise<void> {
    const files = await getFileLister().list('input');
    this.postFileUpdate('Base', files, {
      notifyWhenEmpty: Boolean(message.notifyWhenEmpty),
      preserveBaseFile: message.preserveBaseFile,
    });
    this.postGettingStartedBanner(files.length === 0);
  }

  handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
    this.postMessage({ command: message.command, files: message.files });
  }

  async handleSelectMultipleFiles(
    message: SelectMultipleFilesMessage,
  ): Promise<void> {
    const { fileType, currentFile } = message;
    const commands = isMultipleDocumentFileType(fileType)
      ? MULTIPLE_FILE_COMMANDS.get(fileType)
      : undefined;
    if (!commands) {
      logger.warn(CHANNEL, `Unsupported multiple file selection: ${fileType}`);
      return;
    }
    try {
      const selectedFiles =
        fileType === 'output'
          ? await this.selectOutputFiles(currentFile)
          : await vscode.commands.executeCommand<string[]>(
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
    this.postBaseFileSelect(inputFiles);
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

    if (fileType === 'edited') {
      const plan = planCurrentFileAsEdited(currentOpenFile, message.baseFile);
      await this.applyBaseFileSelectionPlan(plan, fileType, currentOpenFile);
      return;
    }

    if (fileType === 'base') {
      const artifact = detectGeneratedLatexdiffArtifact(currentOpenFile);
      const derivedBaseFile =
        artifact?.kind === 'versionControlDiff' ? artifact.sourcePath : null;
      const derivedBaseFileExists = derivedBaseFile
        ? await WorkspaceFS.exists(derivedBaseFile)
        : false;
      const plan = planCurrentFileAsBase(
        currentOpenFile,
        derivedBaseFile,
        derivedBaseFileExists,
      );
      await this.applyBaseFileSelectionPlan(plan, fileType, currentOpenFile);
      return;
    }

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
      filePath: currentOpenFile,
      fileType,
    });

    await this.maybeSelectCommitFromDiffFile(currentOpenFile);
  }

  /** Apply a host-neutral base-file selection plan to the VS Code host. */
  private async applyBaseFileSelectionPlan(
    plan: MainViewBaseFileSelectionPlan,
    fileType: CurrentFileType,
    currentOpenFile: string,
  ): Promise<void> {
    if (plan.log) {
      const logFn = plan.log.level === 'info' ? logger.info : logger.warn;
      logFn(CHANNEL, plan.log.message);
    }

    if (plan.notification) {
      vscode.window.showInformationMessage(plan.notification.message);
    }

    if (plan.shouldRequestBaseFile) {
      await this.handleRequestBaseFile({
        command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
        preserveBaseFile: true,
      });
    }

    if (plan.shouldPostSetCurrentFile) {
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
        filePath: plan.filePathToSelect,
        fileType,
      });
      await this.maybeSelectCommitFromDiffFile(currentOpenFile);
    }
  }

  private async maybeSelectCommitFromDiffFile(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const artifact = detectGeneratedLatexdiffArtifact(filePath);
    if (artifact?.kind !== 'versionControlDiff' || !artifact.commitHash) {
      return;
    }

    const { commitHash } = artifact;
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
      logger.info(
        CHANNEL,
        `Commit ${commitHash} from ${fileName} was not found in repository history`,
      );
      vscode.window.showInformationMessage(
        `The commit ${commitHash} referenced by ${fileName} was not found in the repository history.`,
      );
    }
  }

  async handleAddOpenedFiles(
    fileType: ExtendedDocumentFileType,
  ): Promise<void> {
    const openedFiles = await this.getOpenedFiles();
    const allowedExtensions = new Set(
      getIncludedExtensions(fileType as ExtensionCategory).map(
        normalizeMainViewFileExtension,
      ),
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
      shouldFilter: true,
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
      allowedExtensions: this.getAllowedDropExtensions(),
      target: message.target ?? undefined,
    });

    for (const fileType of MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES) {
      const droppedFiles = plan.filesByCategory[fileType];
      if (droppedFiles.length === 0) continue;
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_OPENED_FILES,
        files: droppedFiles,
        fileType,
        shouldFilter: true,
      });
    }

    this.showDroppedFilesResult(plan.attachedCount, plan.rejectedCount);
  }

  handleUpdateFiles(message: UpdateFilesMessage): void {
    const fileType = message.command.replace('update', '');
    logger.debug(
      CHANNEL,
      `Updating ${fileType} with ${message.files?.length ?? 0} files`,
    );
    this.postMessage({ command: `set${fileType}`, files: message.files ?? [] });
  }

  async selectOutputFiles(currentInputFile?: string): Promise<string[] | null> {
    try {
      const relativePaths = await selectFiles({
        allowMany: true,
        openLabel: 'Select Output Files',
        filters: { 'Text files': ['tex', 'txt', 'md'] },
        currentFile: currentInputFile,
      });

      if (relativePaths) {
        logger.info(
          CHANNEL,
          `Selected output files: ${relativePaths.join(', ')}`,
        );
        vscode.window.showInformationMessage(
          `Selected output files: ${relativePaths.join(', ')}`,
        );
      }
      return relativePaths;
    } catch (err) {
      await showLoggedErrorMessage(
        CHANNEL,
        'Error selecting output files',
        err,
      );
      return null;
    }
  }

  private postFileUpdate(
    fileType: string,
    files: string[],
    options: FileUpdateOptions = {},
  ): void {
    if (options.notifyWhenEmpty && files.length === 0) {
      logger.debug(
        CHANNEL,
        `No ${fileType.toLowerCase()} files were found during refresh.`,
      );
    }
    this.postMessage({
      command: `set${fileType}File`,
      files,
      ...(options.preserveBaseFile ? { preserveBaseFile: true } : {}),
    });
  }

  /** Post show/hide getting started banner based on condition and setting */
  private postGettingStartedBanner(show: boolean): void {
    const enabled =
      show && getConfig<boolean>('ui.showGettingStartedBanner', true);
    this.postMessage({
      command: enabled
        ? MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER
        : MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    });
  }

  private postBaseFileSelect(baseFiles: string[]): void {
    this.postFileUpdate('Base', baseFiles, { preserveBaseFile: true });
  }

  private async getOpenedFiles(): Promise<string[]> {
    if (!WorkspaceFS.getPath()) {
      logger.warn(CHANNEL, 'No workspace path found for opened files');
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

    logger.debug(CHANNEL, `Found opened files: ${relevantFiles.join(', ')}`);
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
      logger.debug(
        CHANNEL,
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

  private getAllowedDropExtensions(): MainViewAllowedDropExtensions {
    return {
      input: getIncludedExtensions('input'),
      context: getIncludedExtensions('context'),
      media: getIncludedExtensions('media'),
    };
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
