// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { workspace } from 'vscode';

// Local imports - webview
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';

// Local imports - agent
import { getAgentPath } from '@agent/runtime/executeAgent';
import { showLoggedMessage } from '@common/errors/errorHandlingUtils';

// Local imports - commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { fileLister } from '@frontend/files/fileLister';
import { uncapitalize } from '@frontend/ui/messageUtils';

// Local imports - log
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'FileManager';
logger.initialize(CHANNEL);

type FileUpdateOptions = {
  notifyWhenEmpty?: boolean;
  additionalPayload?: Record<string, unknown>;
};

export class FileManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async handleFileSelection(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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

  async handleEditedFileSelection(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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

  async handleInputFileSelected(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const baseFileNameForInput = path.basename(
      message.filePath,
      path.extname(message.filePath),
    );
    const filteredEditedFiles =
      await fileLister.listEditedFiles(baseFileNameForInput);
    this.postFileUpdate(webviewView, 'Edited', filteredEditedFiles);
  }

  handleGenericFileSelected(message: any): void {
    logger.debug(CHANNEL, `${message.command}: ${message.filePath}`);
  }

  async handleRequestInputFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const refreshedInputFiles =
      (await vscode.commands.executeCommand<string[]>(
        'texra.refreshInputFiles',
      )) || [];
    await this.postFileUpdate(webviewView, 'Input', refreshedInputFiles, {
      notifyWhenEmpty: Boolean(message?.notifyWhenEmpty),
    });
  }

  async handleRequestFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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
    await this.postFileUpdate(webviewView, fileType, files, {
      notifyWhenEmpty: Boolean(message?.notifyWhenEmpty),
    });
  }

  async handleRequestEditedFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    let allEditedFiles: string[] = [];
    if (message.baseFile) {
      const baseFileNameForEdited = path.basename(
        message.baseFile,
        path.extname(message.baseFile),
      );
      allEditedFiles = await fileLister.listEditedFiles(baseFileNameForEdited);
    }
    await this.postFileUpdate(webviewView, 'Edited', allEditedFiles, {
      notifyWhenEmpty: Boolean(message?.notifyWhenEmpty),
    });
  }

  async handleRequestBaseFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const files = await fileLister.list('input');
    await this.postFileUpdate(webviewView, 'Base', files, {
      notifyWhenEmpty: Boolean(message?.notifyWhenEmpty),
      additionalPayload: message?.preserveBaseFile
        ? { preserveBaseFile: true }
        : undefined,
    });
  }

  async handleRequestDefaultOutputFiles(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const agent = message.agent;
    if (!agent) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES,
        files: [],
      });
      return;
    }

    try {
      const agentPath = await getAgentPath(agent, this.context);
      const [settings] = await loadAgentSettingAndPrompts(agentPath, agent);
      const files = Array.isArray(settings?.defaultOutputFiles)
        ? settings.defaultOutputFiles
        : [];
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES,
        files,
      });
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error requesting default output files: ${err instanceof Error ? err.message : String(err)}`,
      );
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES,
        files: [],
      });
    }
  }

  handleSetMultipleFiles(message: any, webviewView: vscode.WebviewView): void {
    if (message.files?.length > 0) {
      webviewView.webview.postMessage({
        command: message.command,
        files: message.files,
      });
    }
  }

  async handleSelectMultipleFiles(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
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
      logger.error(
        CHANNEL,
        `Error in handleSelectMultipleFiles: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.showErrorMessage(
        `Error selecting ${fileType}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async handleRefreshAllFiles(webviewView: vscode.WebviewView): Promise<void> {
    const refreshedFiles = {
      input: await fileLister.list('input'),
      reference: await fileLister.list('reference'),
      auxiliary: await fileLister.list('auxiliary'),
      media: await fileLister.list('media'),
    };

    Object.entries(refreshedFiles).forEach(([type, files]) => {
      this.postFileUpdate(
        webviewView,
        type.charAt(0).toUpperCase() + type.slice(1),
        files,
      );
    });

    await this.updateBaseFileSelect(webviewView);
  }

  async handleGetCurrentFile(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const fileType = message.fileType || 'input';
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
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
          filePath: currentOpenFile,
          fileType,
        });
        commitCheckFile = currentOpenFile;
      }
      if (commitCheckFile) {
        await this._maybeSelectCommitFromDiffFile(commitCheckFile, webviewView);
      }
    } else {
      vscode.window.showInformationMessage(
        'No file is currently open or the file is not part of the workspace.',
      );
    }
  }

  private async _maybeSelectCommitFromDiffFile(
    filePath: string,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const fileName = path.basename(filePath);
    const commitMatch = fileName.match(/-diff([0-9a-fA-F]{4,40})/);
    if (!commitMatch) {
      return;
    }

    const commitHash = commitMatch[1];
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

  async handleAddOpenedFiles(
    fileType: string,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const openedFiles = await this.getOpenedFiles();
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_OPENED_FILES,
      files: openedFiles,
      fileType,
      shouldFilter: true,
    });
  }

  async handleUpdateFiles(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const command = message.command;
    const fileType = command.replace('update', '');
    const files = message.files || [];

    logger.debug(CHANNEL, `Updating ${fileType} with ${files.length} files`);
    webviewView.webview.postMessage({ command: `set${fileType}`, files });
  }

  async selectOutputFiles(currentInputFile: string): Promise<string[] | null> {
    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      await showLoggedMessage(CHANNEL, 'No workspace folder open');
      return null;
    }

    const defaultUri = currentInputFile
      ? vscode.Uri.file(
          path.dirname(path.join(workspacePath, currentInputFile)),
        )
      : vscode.Uri.file(workspacePath);

    try {
      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Output Files',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri,
        filters: { 'Text files': ['tex', 'txt', 'md'] },
      });

      if (!fileUris || fileUris.length === 0) {
        return null;
      }

      const relativePaths = fileUris.map((uri) =>
        WorkspaceFS.relativePath(uri.fsPath),
      );
      logger.info(
        CHANNEL,
        `Selected output files: ${relativePaths.join(', ')}`,
      );
      vscode.window.showInformationMessage(
        `Selected output files: ${relativePaths.join(', ')}`,
      );
      return relativePaths;
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error selecting output files: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(
        `Error selecting output files: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async postFileUpdate(
    webviewView: vscode.WebviewView,
    fileType: string,
    files: string[],
    options: FileUpdateOptions = {},
  ): Promise<void> {
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

  private async updateBaseFileSelect(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const baseFiles = await fileLister.list('input');
    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
      files: baseFiles,
      preserveBaseFile: true,
    });
  }

  private async getOpenedFiles(): Promise<string[]> {
    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      logger.warn(CHANNEL, 'No workspace path found for opened files');
      return [];
    }

    const modelNames = getConfig<string[]>('models', []);
    const openedDocuments = workspace.textDocuments;
    const relevantFiles = openedDocuments
      .filter((doc) => doc.uri.scheme === 'file')
      .map((doc) => workspace.asRelativePath(doc.uri.fsPath, false))
      .filter((filePath) => {
        const fileName = path.basename(filePath);
        return !modelNames.some((model) => fileName.includes(`_${model}`));
      });

    logger.debug(CHANNEL, `Found opened files: ${relevantFiles.join(', ')}`);
    return relevantFiles;
  }
}
