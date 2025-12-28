// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { workspace } from 'vscode';

// Local imports - webview
import { getAgent } from '@agent/index';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
  toErrorMessage,
} from '@common/errors';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { selectFiles } from '@frontend/ui/dialogs';
import { fileLister } from '@frontend/files';
import { uncapitalize } from '@frontend/ui/messageUtils';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { BaseWebviewManager } from './BaseWebviewManager';

// Local imports - types
import type {
  FileSelectionMessage,
  FileSelectedMessage,
  RequestInputFileMessage,
  RequestFileMessage,
  RequestEditedFileMessage,
  RequestBaseFileMessage,
  RequestDefaultOutputFilesMessage,
  SetMultipleFilesMessage,
  SelectMultipleFilesMessage,
  GetCurrentFileMessage,
  UpdateFilesMessage,
} from '../types/messages';

const CHANNEL = 'FileManager';
logger.initialize(CHANNEL);

const LATEX_DIFF_BASENAME_PATTERN = /^(.+?)-diff([0-9a-fA-F]{4,40})$/;

type FileUpdateOptions = {
  notifyWhenEmpty?: boolean;
  additionalPayload?: Record<string, unknown>;
};

export class FileManager extends BaseWebviewManager {
  protected readonly channel = CHANNEL;

  constructor(_context: vscode.ExtensionContext) {
    super();
  }

  async handleFileSelection(message: FileSelectionMessage): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const singleFileType = message.command.replace('select', '');
    logger.debug(CHANNEL, `Selecting ${singleFileType}`);

    const file = await vscode.commands.executeCommand<string>(
      `texra.${message.command}`,
    );
    if (file) {
      logger.debug(CHANNEL, `Selected ${singleFileType}: ${file}`);
      webviewView.webview.postMessage({
        command: `${uncapitalize(singleFileType)}Selected`,
        filePath: file,
      });
    }
  }

  async handleEditedFileSelection(): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const editedFile = await vscode.commands.executeCommand<string>(
      'texra.selectEditedFile',
    );
    if (editedFile) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED,
        filePath: editedFile,
      });
    }
  }

  async handleInputFileSelected(message: FileSelectedMessage): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
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
    if (!this.getWebview()) {
      return;
    }
    const refreshedInputFiles =
      (await vscode.commands.executeCommand<string[]>(
        'texra.refreshInputFiles',
      )) ?? [];
    await this.postFileUpdate('Input', refreshedInputFiles, {
      notifyWhenEmpty: !!message.notifyWhenEmpty,
    });

    this.updateGettingStartedBanner(refreshedInputFiles.length === 0);
  }

  async handleRequestFile(message: RequestFileMessage): Promise<void> {
    const fileType = message.command.replace('request', '').replace('File', '');
    const files = await (async () => {
      switch (fileType) {
        case 'Reference':
          return await fileLister.list('reference');
        case 'Auxiliary':
          return await fileLister.list('auxiliary');
        case 'Media':
          return await fileLister.list('media');
        default:
          return [];
      }
    })();
    await this.postFileUpdate(fileType, files, {
      notifyWhenEmpty: !!message.notifyWhenEmpty,
    });
  }

  async handleRequestEditedFile(
    message: RequestEditedFileMessage,
  ): Promise<void> {
    let allEditedFiles: string[] = [];
    if (message.baseFile) {
      const baseFileNameForEdited = path.basename(
        message.baseFile,
        path.extname(message.baseFile),
      );
      allEditedFiles = await fileLister.listEditedFiles(baseFileNameForEdited);
    }
    await this.postFileUpdate('Edited', allEditedFiles, {
      notifyWhenEmpty: !!message.notifyWhenEmpty,
    });
  }

  async handleRequestBaseFile(message: RequestBaseFileMessage): Promise<void> {
    const files = await fileLister.list('input');
    await this.postFileUpdate('Base', files, {
      notifyWhenEmpty: !!message.notifyWhenEmpty,
      additionalPayload: message.preserveBaseFile
        ? { preserveBaseFile: true }
        : undefined,
    });

    this.updateGettingStartedBanner(files.length === 0);
  }

  async handleRequestDefaultOutputFiles(
    message: RequestDefaultOutputFilesMessage,
  ): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const agentIdentifier = message.agent;
    if (!agentIdentifier) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES,
        files: [],
      });
      return;
    }

    try {
      const entry = getAgent(agentIdentifier);
      const files = entry?.defaultOutputFiles ?? [];
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES,
        files,
      });
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error requesting default output files: ${toErrorMessage(err)}`,
      );
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES,
        files: [],
      });
    }
  }

  handleSetMultipleFiles(message: SetMultipleFilesMessage): void {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    if (message.files && message.files.length > 0) {
      webviewView.webview.postMessage({
        command: message.command,
        files: message.files,
      });
    }
  }

  async handleSelectMultipleFiles(
    message: SelectMultipleFilesMessage,
  ): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const fileType = message.fileType;
    let selectedFiles: string[] | null = null;

    try {
      if (fileType === 'OutputFiles') {
        selectedFiles = await this.selectOutputFiles(message.currentFile);
      } else {
        const currentFileForMultiple = message.currentFile;
        const baseType = fileType.replace('Files', '');
        selectedFiles = await vscode.commands.executeCommand<string[]>(
          `texra.select${baseType}Files`,
          currentFileForMultiple,
        );
        if (selectedFiles === undefined) {
          logger.warn(
            CHANNEL,
            `Command texra.select${baseType}Files returned undefined`,
          );
          selectedFiles = null;
        }
      }

      if (selectedFiles) {
        webviewView.webview.postMessage({
          command: `set${fileType}`,
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
    const refreshedFiles = {
      input: await fileLister.list('input'),
      reference: await fileLister.list('reference'),
      auxiliary: await fileLister.list('auxiliary'),
      media: await fileLister.list('media'),
    };

    Object.entries(refreshedFiles).forEach(([type, files]) => {
      this.postFileUpdate(type.charAt(0).toUpperCase() + type.slice(1), files);
    });

    await this.updateBaseFileSelect();

    this.updateGettingStartedBanner(refreshedFiles.input.length === 0);
  }

  async handleGetCurrentFile(message: GetCurrentFileMessage): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const fileType = message.fileType ?? 'input';
    const currentOpenFile = await vscode.commands.executeCommand<string>(
      'texra.getCurrentFile',
    );
    if (currentOpenFile) {
      let commitCheckFile: string | null = null;
      if (fileType === 'edited') {
        const baseFile = message.baseFile;
        if (baseFile) {
          const baseFileName = path.basename(baseFile, path.extname(baseFile));
          const currentFileName = path.basename(
            currentOpenFile,
            path.extname(currentOpenFile),
          );
          if (
            currentFileName.startsWith(baseFileName) &&
            currentFileName !== baseFileName
          ) {
            webviewView.webview.postMessage({
              command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
              filePath: currentOpenFile,
              fileType,
            });
            commitCheckFile = currentOpenFile;
          } else {
            vscode.window.showInformationMessage(
              'The current file is not a valid edited version of the base file.',
            );
          }
        } else {
          vscode.window.showInformationMessage(
            'Please select a base file first.',
          );
        }
      } else {
        let filePathToSelect = currentOpenFile;
        if (fileType === 'base') {
          const derivedBaseFile =
            this._deriveBaseFileFromLatexDiff(currentOpenFile);
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

        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
          filePath: filePathToSelect,
          fileType,
        });
        commitCheckFile = currentOpenFile;
      }
      if (commitCheckFile) {
        await this._maybeSelectCommitFromDiffFile(commitCheckFile);
      }
    } else {
      vscode.window.showInformationMessage(
        'No file is currently open or the file is not part of the workspace.',
      );
    }
  }

  private async _maybeSelectCommitFromDiffFile(
    filePath: string,
  ): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const fileName = path.basename(filePath);
    const latexDiffMetadata = this._parseLatexDiffMetadata(filePath);
    if (!latexDiffMetadata) {
      return;
    }

    const { commitHash } = latexDiffMetadata;
    const commitLabel = await vscode.commands.executeCommand<string | null>(
      'texra.findCommitInHistory',
      commitHash,
    );

    if (commitLabel) {
      webviewView.webview.postMessage({
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
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const openedFiles = await this.getOpenedFiles();
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_OPENED_FILES,
      files: openedFiles,
      fileType,
      shouldFilter: true,
    });
  }

  async handleUpdateFiles(message: UpdateFilesMessage): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const command = message.command;
    const fileType = command.replace('update', '');
    const files = message.files ?? [];

    logger.debug(CHANNEL, `Updating ${fileType} with ${files.length} files`);
    webviewView.webview.postMessage({ command: `set${fileType}`, files });
  }

  private _deriveBaseFileFromLatexDiff(filePath: string): string | null {
    const metadata = this._parseLatexDiffMetadata(filePath);
    if (!metadata) {
      return null;
    }

    const { dir, baseName, ext } = metadata;
    return path.join(dir, `${baseName}${ext}`);
  }

  private _parseLatexDiffMetadata(
    filePath: string,
  ): { dir: string; baseName: string; ext: string; commitHash: string } | null {
    const { dir, name, ext } = path.parse(filePath);
    const match = name.match(LATEX_DIFF_BASENAME_PATTERN);
    if (!match) {
      return null;
    }

    const [, baseName, commitHash] = match;
    if (!baseName || !commitHash) {
      return null;
    }

    return { dir, baseName, ext, commitHash };
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

  private async postFileUpdate(
    fileType: string,
    files: string[],
    options: FileUpdateOptions = {},
  ): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    if (options.notifyWhenEmpty && files.length === 0) {
      logger.debug(
        CHANNEL,
        `No ${fileType.toLowerCase()} files were found during refresh.`,
      );
    }

    webviewView.webview.postMessage({
      command: `set${fileType}File`,
      files,
      ...(options.additionalPayload ?? {}),
    });
  }

  private async updateBaseFileSelect(): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    const baseFiles = await fileLister.list('input');
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
      files: baseFiles,
      preserveBaseFile: true,
    });
  }

  private updateGettingStartedBanner(isEmpty: boolean): void {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    webviewView.webview.postMessage({
      command: isEmpty
        ? MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER
        : MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    });
  }

  private async getOpenedFiles(): Promise<string[]> {
    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      logger.warn(CHANNEL, 'No workspace path found for opened files');
      return [];
    }

    const openedDocuments = workspace.textDocuments;
    const relevantFiles = openedDocuments
      .filter((doc) => doc.uri.scheme === 'file')
      .map((doc) => workspace.asRelativePath(doc.uri.fsPath, false));

    logger.debug(CHANNEL, `Found opened files: ${relevantFiles.join(', ')}`);
    return relevantFiles;
  }
}
