import * as path from 'path';

import * as vscode from 'vscode';
import { workspace } from 'vscode';

import { normalizeFilePath } from '@shared/utils/path';
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
} from '@common/files';
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { fileLister } from '@frontend/files';
import { selectFiles } from '@frontend/ui/dialogs';
import * as logger from '@logger/logUtils';
import {
  WorkspaceFS,
  parseLatexDiffMetadata,
  deriveBaseFileFromLatexDiff,
} from '@utils/files';

import { BaseWebviewManager } from './BaseWebviewManager';
import type { ExtendedFileType, MainViewInboundMessage } from '@shared/schemas';

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
      await fileLister.listEditedFiles(baseFileNameForInput);
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
      notifyWhenEmpty: !!message.notifyWhenEmpty,
    });
    this.postMessage({
      command:
        refreshedInputFiles.length === 0
          ? MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    });
  }

  async handleRequestFile(message: RequestFileMessage): Promise<void> {
    const fileType = message.command.replace('request', '').replace('File', '');
    const listTypeMap: Record<string, 'reference' | 'auxiliary' | 'media'> = {
      Reference: 'reference',
      Auxiliary: 'auxiliary',
      Media: 'media',
    };
    const listType = listTypeMap[fileType];
    const files = listType ? await fileLister.list(listType) : [];
    this.postFileUpdate(fileType, files, {
      notifyWhenEmpty: !!message.notifyWhenEmpty,
    });
  }

  async handleRequestEditedFile(
    message: RequestEditedFileMessage,
  ): Promise<void> {
    const files = message.baseFile
      ? await fileLister.listEditedFiles(
          path.basename(message.baseFile, path.extname(message.baseFile)),
        )
      : [];
    this.postFileUpdate('Edited', files, {
      notifyWhenEmpty: !!message.notifyWhenEmpty,
    });
  }

  async handleRequestBaseFile(message: RequestBaseFileMessage): Promise<void> {
    const files = await fileLister.list('input');
    this.postFileUpdate('Base', files, {
      notifyWhenEmpty: !!message.notifyWhenEmpty,
      additionalPayload: message.preserveBaseFile
        ? { preserveBaseFile: true }
        : undefined,
    });
    this.postMessage({
      command:
        files.length === 0
          ? MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    });
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
    if (message.files.length > 0) {
      this.postMessage({ command: message.command, files: message.files });
    }
  }

  async handleSelectMultipleFiles(
    message: SelectMultipleFilesMessage,
  ): Promise<void> {
    const { fileType, currentFile } = message;
    const commands = MULTIPLE_FILE_COMMANDS.get(fileType);
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
    const [input, reference, auxiliary, media] = await Promise.all([
      fileLister.list('input'),
      fileLister.list('reference'),
      fileLister.list('auxiliary'),
      fileLister.list('media'),
    ]);
    const refreshedFiles = { input, reference, auxiliary, media };

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES,
      inputFiles: refreshedFiles.input,
      referenceFiles: refreshedFiles.reference,
      auxiliaryFiles: refreshedFiles.auxiliary,
      mediaFiles: refreshedFiles.media,
    });

    await this.updateBaseFileSelect();
    this.postMessage({
      command:
        refreshedFiles.input.length === 0
          ? MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    });
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

    const filePathToSelect = await this.resolveFilePathForType(
      currentOpenFile,
      fileType,
    );

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

  private async resolveFilePathForType(
    currentOpenFile: string,
    fileType: string,
  ): Promise<string> {
    if (fileType !== 'base') {
      return currentOpenFile;
    }

    const derivedBaseFile = deriveBaseFileFromLatexDiff(currentOpenFile);
    if (!derivedBaseFile) {
      return currentOpenFile;
    }

    const baseExists = await WorkspaceFS.exists(derivedBaseFile);
    if (!baseExists) {
      logger.info(
        CHANNEL,
        `Derived base file ${derivedBaseFile} from ${currentOpenFile} does not exist on disk`,
      );
      vscode.window.showInformationMessage(
        `The base file ${derivedBaseFile} could not be found. Keeping ${currentOpenFile} selected.`,
      );
      return currentOpenFile;
    }

    await this.handleRequestBaseFile({
      command: 'requestBaseFile',
      preserveBaseFile: true,
    });
    return derivedBaseFile;
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
    const allowedExtensions = getIncludedExtensions(
      fileType as ExtensionCategory,
    ).map((ext) => ext.replace('.', '').toLowerCase());
    const filteredFiles =
      allowedExtensions.length > 0
        ? openedFiles.filter((file) => {
            const ext = path.extname(file).toLowerCase().replace('.', '');
            return allowedExtensions.includes(ext);
          })
        : openedFiles;

    this.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_OPENED_FILES,
      files: filteredFiles,
      fileType,
      shouldFilter: true,
    });
  }

  async handleUpdateFiles(message: UpdateFilesMessage): Promise<void> {
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

  private async updateBaseFileSelect(): Promise<void> {
    const baseFiles = await fileLister.list('input');
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
      ...new Set(
        fileUris.map((uri) =>
          normalizeFilePath(workspace.asRelativePath(uri.fsPath, false)),
        ),
      ),
    ];

    logger.debug(CHANNEL, `Found opened files: ${relevantFiles.join(', ')}`);
    return relevantFiles;
  }
}
