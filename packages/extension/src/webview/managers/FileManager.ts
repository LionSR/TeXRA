import * as path from 'path';
import { fileURLToPath } from 'url';

import * as vscode from 'vscode';

import { getAgent } from '@agent/index';
import {
  ExtensionCategory,
  FILE_SELECTION_COMMANDS,
  FILE_SELECTION_COMMAND_IDS,
  FILE_SELECTION_RESPONSES,
  MULTIPLE_FILE_COMMANDS,
  getIncludedExtensions,
  type FileSelectionCommand,
  type FileSelectionResponseCommand,
  type MultiFileCategory,
} from '@common/files';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { getFileLister } from '@frontend/files';
import {
  showLoggedErrorMessage,
  toErrorMessage,
} from '@frontend/ui/errorHandlingUtils';
import { selectFiles } from '@frontend/ui/dialogs';
import * as logger from '@logger/logUtils';
import type {
  MainViewInboundMessage,
  MultipleDocumentFileType,
} from '@shared/schemas';
import {
  WorkspaceFS,
  parseLatexDiffMetadata,
  deriveBaseFileFromLatexDiff,
} from '@utils/files';

import { getConfig } from '@utils/config';

import { BaseWebviewManager } from './BaseWebviewManager';

type MessageFor<C extends MainViewInboundMessage['command']> = Extract<
  MainViewInboundMessage,
  { command: C }
>;

type FileSelectionMessage = MessageFor<FileSelectionCommand>;

type FileSelectedMessage = MessageFor<FileSelectionResponseCommand>;

type RequestInputFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE
>;

type RequestFileMessage = MessageFor<
  | typeof MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE
  | typeof MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE
  | typeof MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE
>;

type RequestEditedFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE
>;

type RequestBaseFileMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE
>;

type RequestDefaultOutputFilesMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES
>;

type SetMultipleFilesMessage = MessageFor<
  | typeof MAIN_VIEW_COMMANDS.SET_INPUT_FILES
  | typeof MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES
  | typeof MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES
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
  | typeof MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES
  | typeof MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES
  | typeof MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES
  | typeof MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES
>;

const CHANNEL = 'FileManager';
logger.initialize(CHANNEL);

const ATTACHABLE_DROP_CATEGORIES = [
  'input',
  'reference',
  'media',
] as const satisfies readonly MultipleDocumentFileType[];

type AttachableDropCategory = (typeof ATTACHABLE_DROP_CATEGORIES)[number];
type AllowedDropExtensions = Map<AttachableDropCategory, Set<string>>;

type FileUpdateOptions = {
  notifyWhenEmpty?: boolean;
  additionalPayload?: Record<string, unknown>;
};

export class FileManager extends BaseWebviewManager {
  protected readonly channel = CHANNEL;

  async handleFileSelection(message: FileSelectionMessage): Promise<void> {
    const executeCommand = FILE_SELECTION_COMMANDS.get(message.command);
    const responseCommand = FILE_SELECTION_RESPONSES.get(message.command);
    const singleFileType = message.command.replace('select', '');
    if (!executeCommand || !responseCommand) {
      logger.warn(CHANNEL, `Unsupported file command: ${message.command}`);
      return;
    }

    logger.debug(CHANNEL, `Selecting ${singleFileType}`);
    const file = await vscode.commands.executeCommand<string>(executeCommand);
    if (file) {
      logger.debug(CHANNEL, `Selected ${singleFileType}: ${file}`);
      this.postMessage({
        command: responseCommand,
        filePath: file,
      });
    }
  }

  async handleEditedFileSelection(): Promise<void> {
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

  async handleInputFileSelected(message: FileSelectedMessage): Promise<void> {
    if (!message.filePath) {
      this.postFileUpdate('Edited', []);
      return;
    }
    const baseFileNameForInput = path.basename(
      message.filePath,
      path.extname(message.filePath),
    );
    const filteredEditedFiles =
      await getFileLister().listEditedFiles(baseFileNameForInput);
    this.postFileUpdate('Edited', filteredEditedFiles);
  }

  handleGenericFileSelected(message: FileSelectedMessage): void {
    logger.debug(CHANNEL, `${message.command}: ${message.filePath}`);
  }

  async handleRequestInputFile(
    message: RequestInputFileMessage,
  ): Promise<void> {
    const refreshedInputFiles =
      (await vscode.commands.executeCommand<string[]>(
        FILE_SELECTION_COMMAND_IDS.refreshInputFiles,
      )) ?? [];
    this.postFileUpdate('Input', refreshedInputFiles, {
      notifyWhenEmpty: Boolean(message.notifyWhenEmpty),
    });
    this.postGettingStartedBanner(refreshedInputFiles.length === 0);
  }

  async handleRequestFile(message: RequestFileMessage): Promise<void> {
    const fileType = message.command.replace('request', '').replace('File', '');
    const listType = fileType.toLowerCase() as
      | 'reference'
      | 'auxiliary'
      | 'media';
    const files = await getFileLister().list(listType);
    this.postFileUpdate(fileType, files, {
      notifyWhenEmpty: Boolean(message.notifyWhenEmpty),
    });
  }

  async handleRequestEditedFile(
    message: RequestEditedFileMessage,
  ): Promise<void> {
    const files = message.baseFile
      ? await getFileLister().listEditedFiles(
          path.basename(message.baseFile, path.extname(message.baseFile)),
        )
      : [];
    this.postFileUpdate('Edited', files, {
      notifyWhenEmpty: Boolean(message.notifyWhenEmpty),
    });
  }

  async handleRequestBaseFile(message: RequestBaseFileMessage): Promise<void> {
    const files = await getFileLister().list('input');
    this.postFileUpdate('Base', files, {
      notifyWhenEmpty: Boolean(message.notifyWhenEmpty),
      additionalPayload: message.preserveBaseFile
        ? { preserveBaseFile: true }
        : undefined,
    });
    this.postGettingStartedBanner(files.length === 0);
  }

  async handleRequestDefaultOutputFiles(
    message: RequestDefaultOutputFilesMessage,
  ): Promise<void> {
    let files: string[] = [];
    if (message.agent) {
      try {
        const entry = getAgent(message.agent);
        files = entry?.defaultOutputFiles ?? [];
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error requesting default output files: ${toErrorMessage(err)}`,
        );
      }
    }
    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES,
      files,
    });
  }

  handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
    this.postMessage({ command: message.command, files: message.files });
  }

  async handleSelectMultipleFiles(
    message: SelectMultipleFilesMessage,
  ): Promise<void> {
    const { fileType, currentFile } = message;
    const commands = MULTIPLE_FILE_COMMANDS.get(fileType as MultiFileCategory);
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

  async handleRefreshAllFiles(): Promise<void> {
    const [inputFiles, referenceFiles, auxiliaryFiles, mediaFiles] =
      await Promise.all([
        getFileLister().list('input'),
        getFileLister().list('reference'),
        getFileLister().list('auxiliary'),
        getFileLister().list('media'),
      ]);

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES,
      inputFiles,
      referenceFiles,
      auxiliaryFiles,
      mediaFiles,
    });

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
      await this.handleGetCurrentEditedFile(currentOpenFile, message.baseFile);
      return;
    }

    let filePathToSelect = currentOpenFile;
    if (fileType === 'base') {
      const derivedBaseFile = deriveBaseFileFromLatexDiff(currentOpenFile);
      if (derivedBaseFile) {
        const baseExists = await WorkspaceFS.exists(derivedBaseFile);
        if (baseExists) {
          await this.handleRequestBaseFile({
            command: 'requestBaseFile',
            preserveBaseFile: true,
          });
          filePathToSelect = derivedBaseFile;
        } else {
          logger.info(
            CHANNEL,
            `Derived base file ${derivedBaseFile} from ${currentOpenFile} does not exist on disk`,
          );
          vscode.window.showInformationMessage(
            `The base file ${derivedBaseFile} could not be found. Keeping ${currentOpenFile} selected.`,
          );
        }
      }
    }

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
      filePath: filePathToSelect,
      fileType,
    });

    await this.maybeSelectCommitFromDiffFile(currentOpenFile);
  }

  private async handleGetCurrentEditedFile(
    currentOpenFile: string,
    baseFile?: string,
  ): Promise<void> {
    if (!baseFile) {
      vscode.window.showInformationMessage('Please select a base file first.');
      return;
    }

    const baseFileName = path.basename(baseFile, path.extname(baseFile));
    const currentFileName = path.basename(
      currentOpenFile,
      path.extname(currentOpenFile),
    );

    const isValidEditedFile =
      currentFileName.startsWith(baseFileName) &&
      currentFileName !== baseFileName;

    if (!isValidEditedFile) {
      vscode.window.showInformationMessage(
        'The current file is not a valid edited version of the base file.',
      );
      return;
    }

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
      filePath: currentOpenFile,
      fileType: 'edited',
    });

    await this.maybeSelectCommitFromDiffFile(currentOpenFile);
  }

  private async maybeSelectCommitFromDiffFile(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const latexDiffMetadata = parseLatexDiffMetadata(filePath);
    if (!latexDiffMetadata) {
      return;
    }

    const { commitHash } = latexDiffMetadata;
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

  async handleAddOpenedFiles(fileType: string): Promise<void> {
    const openedFiles = await this.getOpenedFiles();
    const allowedExtensions = new Set(
      getIncludedExtensions(fileType as ExtensionCategory).map((ext) =>
        ext.replace('.', '').toLowerCase(),
      ),
    );

    const filteredFiles =
      allowedExtensions.size > 0
        ? openedFiles.filter((file) =>
            allowedExtensions.has(
              path.extname(file).toLowerCase().replace('.', ''),
            ),
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
    const grouped = new Map<AttachableDropCategory, Set<string>>(
      ATTACHABLE_DROP_CATEGORIES.map((category) => [category, new Set()]),
    );
    const allowedExtensions = this.getAllowedDropExtensions();
    let rejectedCount = 0;

    for (const rawPath of message.paths) {
      const filePath = await this.resolveWorkspaceDropFile(rawPath);
      const category = filePath
        ? this.resolveDroppedFileCategory(
            filePath,
            allowedExtensions,
            message.target ?? undefined,
          )
        : null;
      if (!filePath || !category) {
        rejectedCount += 1;
        continue;
      }
      grouped.get(category)?.add(filePath);
    }

    let attachedCount = 0;
    for (const [fileType, files] of grouped) {
      if (files.size === 0) continue;
      const droppedFiles = [...files];
      attachedCount += droppedFiles.length;
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_OPENED_FILES,
        files: droppedFiles,
        fileType,
        shouldFilter: true,
      });
    }

    this.showDroppedFilesResult(attachedCount, rejectedCount);
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
      ...(options.additionalPayload ?? {}),
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
    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
      files: baseFiles,
      preserveBaseFile: true,
    });
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

  private resolveDroppedFileCategory(
    filePath: string,
    allowedExtensions: AllowedDropExtensions,
    target?: MultipleDocumentFileType,
  ): AttachableDropCategory | null {
    if (target) {
      return this.isAttachableDropCategory(target) &&
        this.isExtensionAllowed(target, filePath, allowedExtensions)
        ? target
        : null;
    }

    const extension = this.normalizedExtension(filePath);
    if (this.isExtensionAllowed('media', filePath, allowedExtensions)) {
      return 'media';
    }
    if (
      (extension === 'bib' ||
        extension === 'bbl' ||
        extension === 'cls' ||
        extension === 'sty') &&
      this.isExtensionAllowed('reference', filePath, allowedExtensions)
    ) {
      return 'reference';
    }
    if (this.isExtensionAllowed('input', filePath, allowedExtensions)) {
      return 'input';
    }
    if (this.isExtensionAllowed('reference', filePath, allowedExtensions)) {
      return 'reference';
    }
    return null;
  }

  private isAttachableDropCategory(
    category: MultipleDocumentFileType,
  ): category is AttachableDropCategory {
    return (ATTACHABLE_DROP_CATEGORIES as readonly string[]).includes(category);
  }

  private isExtensionAllowed(
    category: AttachableDropCategory,
    filePath: string,
    allowedExtensions: AllowedDropExtensions,
  ): boolean {
    const extension = this.normalizedExtension(filePath);
    if (!extension) return false;
    return allowedExtensions.get(category)?.has(extension) ?? false;
  }

  private getAllowedDropExtensions(): AllowedDropExtensions {
    return new Map(
      ATTACHABLE_DROP_CATEGORIES.map((category) => [
        category,
        new Set(
          getIncludedExtensions(category).map((ext) =>
            this.normalizedExtension(ext),
          ),
        ),
      ]),
    );
  }

  private normalizedExtension(filePath: string): string {
    const extension = path.extname(filePath) || filePath;
    return extension.trim().toLowerCase().replace(/^\./, '');
  }

  private showDroppedFilesResult(
    attachedCount: number,
    rejectedCount: number,
  ): void {
    if (attachedCount > 0 && rejectedCount === 0) return;
    if (attachedCount > 0) {
      vscode.window.showInformationMessage(
        `Attached ${attachedCount} dropped file${attachedCount === 1 ? '' : 's'}; skipped ${rejectedCount} unsupported, folder, or out-of-workspace item${rejectedCount === 1 ? '' : 's'}.`,
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
