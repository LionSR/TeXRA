// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { workspace } from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath, getRelativePath } from '../utils/workspaceFileUtils';
import { capitalize, uncapitalize } from '../frontend-utils/commonUtils';
import { getConfig } from '../utils/configUtils';
import {
  listInputFiles,
  listReferenceFiles,
  listAuxiliaryFiles,
  listMediaFiles,
  listEditedFiles,
  getFilesIfNotEmpty,
} from '../frontend-utils/fileListingUtils';
import { polishTextWithAI, FileContext } from '../utils/textEnhancementUtils';

// Local imports - agent
import { ToolConfig } from '../agent/ToolConfig';
import { AgentConfig } from '../agent/AgentConfig';

const CHANNEL = 'MessageHandler';

export class WebviewMessageHandler {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async handleMessage(message: any, webviewView: vscode.WebviewView) {
    logger.debug(CHANNEL, `Received message: ${message.command}`);

    switch (message.command) {
      case 'showInformationMessage':
        return this.handleInfoMessage(message);
      case 'getTheme':
        return this.handleThemeRequest(webviewView);
      // Why no agentSelected?
      case 'modelSelected':
        return this.handleModelSelection(message, webviewView);
      case 'execute':
        return this.handleExecute(message);
      case 'merge':
        return this.handleMerge(message);
      case 'compare':
        return this.handleCompare(message);
      case 'acceptEdited':
        return this.handleAcceptEdited(message);
      // File selection cases
      case 'selectInputFile':
      case 'selectReferenceFile':
      case 'selectAuxiliaryFile':
      case 'selectMediaFile':
        return this.handleFileSelection(message, webviewView);
      case 'selectEditedFile':
        return this.handleEditedFileSelection(webviewView);
      // File Selected cases
      case 'inputFileSelected':
        return this.handleInputFileSelected(message, webviewView);
      case 'referenceFileSelected':
      case 'auxiliaryFileSelected':
      case 'mediaFileSelected':
      case 'editedFileSelected':
        return this.handleGenericFileSelected(message);
      // Request File cases
      case 'requestInputFile':
        return this.handleRequestInputFile(webviewView);
      case 'requestReferenceFile':
      case 'requestAuxiliaryFile':
      case 'requestMediaFile':
        return this.handleRequestFile(message, webviewView);
      case 'requestEditedFile':
        return this.handleRequestEditedFile(message, webviewView);
      case 'requestBaseFile':
        return this.handleRequestBaseFile(webviewView);
      // Handle file list updates from webview
      case 'updateInputFiles':
      case 'updateReferenceFiles':
      case 'updateAuxiliaryFiles':
      case 'updateMediaFiles':
      case 'updateOutputFiles':
        return this.handleUpdateFiles(message, webviewView);
      // Multiple file selection cases
      case 'setInputFiles':
      case 'setReferenceFiles':
      case 'setAuxiliaryFiles':
      case 'setMediaFiles':
        return this.handleSetMultipleFiles(message, webviewView);
      case 'selectMultipleFiles':
        return this.handleSelectMultipleFiles(message, webviewView);
      case 'refreshAllFiles':
        return this.handleRefreshAllFiles(webviewView);
      // Housekeeping cases
      case 'cleanOutput':
      case 'cleanBuild':
      case 'indentTeX':
        return this.handleHousekeeping(message);
      case 'packSingle':
      case 'cleanSingle':
        return this.handleSingleOperation(message);
      case 'packMultiple':
      case 'cleanMultiple':
        return this.handleMultipleOperation(message);
      // Latex Diff cases
      case 'latexdiff':
        return this.handleLatexdiff(message);
      case 'latexdiffvc':
        return this.handleLatexdiffvc(message);
      case 'requestRecentCommits':
        return this.handleRequestRecentCommits(webviewView);
      case 'refreshCommits':
        return this.handleRefreshCommits(webviewView);
      case 'packLatexdiffvc':
      case 'cleanLatexdiffvc':
        return this.handleLatexdiffvcOperation(message);
      // VS Code Logic cases
      case 'getCurrentFile':
        return this.handleGetCurrentFile(message, webviewView);
      case 'addOpenedFiles':
        return this.handleAddOpenedFiles(message.fileType, webviewView);
      case 'polishInstructionText':
        return this.handlePolishInstructionText(message, webviewView);
      case 'showAgentHistory':
        this.handleShowAgentHistory();
        break;
    }
  }

  private async handleInfoMessage(message: any) {
    vscode.window.showInformationMessage(message.text);
    logger.debug(CHANNEL, `Information message: ${message.text}`);
  }

  private handleThemeRequest(webviewView: vscode.WebviewView) {
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? 'dark'
        : 'light';
    webviewView.webview.postMessage({ command: 'setTheme', theme });
  }

  private handleModelSelection(message: any, webviewView: vscode.WebviewView) {
    if (message.model) {
      webviewView.webview.postMessage({
        command: 'modelSelected',
        model: message.model,
      });
    }
  }

  private async handleExecute(message: any) {
    if (message.inputFile || message.outputNameOverride) {
      const toolConfig: ToolConfig = {
        // Auto extract settings
        autoExtractFigure: message.autoExtractFigure,
        autoExtractTikzFigure: message.autoExtractTikzFigure,
        // Tool config settings
        reflect: message.reflect,
        attachTeXCount: message.attachTeXCount,
        usePrefillFromInput: message.usePrefillFromInput,
        printInputPrompt: message.printInputPrompt,
      };

      const agentConfig: AgentConfig = {
        agent: message.agent,
        model: message.model,
        instruction: message.instruction,
        inputFile: message.inputFile,
        inputFiles: getFilesIfNotEmpty(message.inputFiles),
        referenceFile: message.referenceFile,
        referenceFiles: getFilesIfNotEmpty(message.referenceFiles),
        auxiliaryFile: message.auxiliaryFile,
        auxiliaryFiles: getFilesIfNotEmpty(message.auxiliaryFiles),
        mediaFile: message.mediaFile,
        mediaFiles: getFilesIfNotEmpty(message.mediaFiles),
        outputFiles: getFilesIfNotEmpty(message.outputFiles),
        outputNameOverride: message.outputNameOverride,
        editedFile: null,
        toolConfig,
      };

      await vscode.commands.executeCommand('texra.execute', agentConfig);
    } else {
      vscode.window.showErrorMessage(
        'Please select an input file or provide an output name override.',
      );
    }
  }

  private async handleMerge(message: any) {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  private async handleCompare(message: any) {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  private async handleAcceptEdited(message: any) {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  private async handleFileSelection(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
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

  private async handleEditedFileSelection(webviewView: vscode.WebviewView) {
    const editedFile = await vscode.commands.executeCommand<string>(
      'texra.selectEditedFile',
    );
    if (editedFile) {
      webviewView.webview.postMessage({
        command: 'editedFileSelected',
        filePath: editedFile,
      });
    }
  }

  private async handleInputFileSelected(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    // vscode.window.showInformationMessage(`Selected file: ${message.filePath}`);
    const baseFileNameForInput = path.basename(
      message.filePath,
      path.extname(message.filePath),
    );
    const filteredEditedFiles = await listEditedFiles(baseFileNameForInput);
    this.postFileUpdate(webviewView, 'Edited', filteredEditedFiles);
  }

  private handleGenericFileSelected(message: any) {
    vscode.window.showInformationMessage(
      `${message.command}: ${message.filePath}`,
    );
  }

  private async handleRequestInputFile(webviewView: vscode.WebviewView) {
    const refreshedInputFiles =
      (await vscode.commands.executeCommand<string[]>(
        'texra.refreshInputFiles',
      )) || [];
    this.postFileUpdate(webviewView, 'Input', refreshedInputFiles);
  }

  private async handleRequestFile(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    const fileType = message.command.replace('request', '').replace('File', '');
    const files = await (async () => {
      switch (fileType) {
        case 'Reference':
          return await listReferenceFiles();
        case 'Auxiliary':
          return await listAuxiliaryFiles();
        case 'Media':
          return await listMediaFiles();
        default:
          return [];
      }
    })();
    this.postFileUpdate(webviewView, fileType, files);
  }

  private async handleRequestEditedFile(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    let allEditedFiles: string[] = [];
    if (message.baseFile) {
      const baseFileNameForEdited = path.basename(
        message.baseFile,
        path.extname(message.baseFile),
      );
      allEditedFiles = await listEditedFiles(baseFileNameForEdited);
    }
    this.postFileUpdate(webviewView, 'Edited', allEditedFiles);
  }

  private async handleRequestBaseFile(webviewView: vscode.WebviewView) {
    this.postFileUpdate(webviewView, 'Base', await listInputFiles());
  }

  private handleSetMultipleFiles(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    if (message.files?.length > 0) {
      webviewView.webview.postMessage({
        command: message.command,
        files: message.files,
      });
    }
  }

  private async handleSelectMultipleFiles(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    const fileType = message.fileType;
    let selectedFiles: string[] | null = null;

    try {
      if (fileType === 'OutputFiles') {
        selectedFiles = await this.selectOutputFiles(message.currentFile);
      } else {
        const currentFileForMultiple = message.currentFile;
        // Extract the base type without the 'Files' suffix
        const baseType = fileType.replace('Files', '');

        selectedFiles = await vscode.commands.executeCommand<string[]>(
          `texra.select${baseType}Files`,
          currentFileForMultiple,
        );

        if (selectedFiles === undefined) {
          console.warn(
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

  private async handleRefreshAllFiles(webviewView: vscode.WebviewView) {
    const refreshedFiles = {
      input: await listInputFiles(),
      reference: await listReferenceFiles(),
      auxiliary: await listAuxiliaryFiles(),
      media: await listMediaFiles(),
    };

    Object.entries(refreshedFiles).forEach(([type, files]) => {
      this.postFileUpdate(webviewView, capitalize(type), files);
    });

    await this.updateBaseFileSelect(webviewView);
  }

  private handleHousekeeping(message: any) {
    vscode.commands.executeCommand(`texra.${message.command}`);
  }

  private handleSingleOperation(message: any) {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
      message.outputNameOverride,
    );
  }

  private handleMultipleOperation(message: any) {
    const operation = message.command.startsWith('pack')
      ? 'Packing'
      : 'Cleaning';

    // Validate outputFiles is an array before joining
    const outputFilesStr = Array.isArray(message.outputFiles)
      ? message.outputFiles.join(', ')
      : '';

    logger.info(
      CHANNEL,
      `${capitalize(operation)} multiple files: ${message.inputFile}, ${outputFilesStr}`,
    );

    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
      message.outputFiles,
      message.outputNameOverride,
    );
  }

  private handleLatexdiff(message: any) {
    vscode.commands.executeCommand(
      'texra.latexdiff',
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  private handleLatexdiffvc(message: any) {
    vscode.commands.executeCommand(
      'texra.latexdiffvc',
      message.inputFile,
      message.baseFile,
      message.commitHash,
    );
  }

  private handleLatexdiffvcOperation(message: any) {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.commitHash,
      message.clean,
    );
  }

  private async handleRequestRecentCommits(webviewView: vscode.WebviewView) {
    const isGitRepo = await vscode.commands.executeCommand<boolean>(
      'texra.isGitRepository',
    );
    const commits = isGitRepo
      ? await vscode.commands.executeCommand<string[]>('texra.getRecentCommits')
      : [];
    webviewView.webview.postMessage({
      command: 'setRecentCommits',
      commits,
      isGitRepo,
    });
  }

  private async handleRefreshCommits(webviewView: vscode.WebviewView) {
    const isGitRepoRefresh = await vscode.commands.executeCommand<boolean>(
      'texra.isGitRepository',
    );
    if (isGitRepoRefresh) {
      const commits_refresh = await vscode.commands.executeCommand<string[]>(
        'texra.getRecentCommits',
      );
      webviewView.webview.postMessage({
        command: 'setRecentCommits',
        commits: commits_refresh,
      });
    } else {
      webviewView.webview.postMessage({
        command: 'setRecentCommits',
        isGitRepo: false,
      });
    }
  }

  private async handleGetCurrentFile(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    const fileType = message.fileType || 'input';
    const currentOpenFile = await vscode.commands.executeCommand<string>(
      'texra.getCurrentFile',
    );
    if (currentOpenFile) {
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
              command: 'setCurrentFile',
              filePath: currentOpenFile,
              fileType: fileType,
            });
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
          command: 'setCurrentFile',
          filePath: currentOpenFile,
          fileType: fileType,
        });
      }
    } else {
      vscode.window.showInformationMessage(
        'No file is currently open or the file is not part of the workspace.',
      );
    }
  }

  private async handleAddOpenedFiles(
    fileType: string,
    webviewView: vscode.WebviewView,
  ) {
    const openedFiles = await this.getOpenedFiles();

    // Send opened files to webview with a flag to filter out already selected files
    webviewView.webview.postMessage({
      command: 'setOpenedFiles',
      files: openedFiles,
      fileType: fileType,
      shouldFilter: true,
    });
  }

  private async postFileUpdate(
    webviewView: vscode.WebviewView,
    fileType: string,
    files: string[],
  ) {
    webviewView.webview.postMessage({
      command: `set${capitalize(fileType)}File`,
      files,
    });
  }

  private async updateBaseFileSelect(webviewView: vscode.WebviewView) {
    const baseFiles = await listInputFiles();
    // logger.debug(CHANNEL, `Updating base files: ${baseFiles.join(', ')}`);
    webviewView.webview.postMessage({
      command: 'setBaseFile',
      files: baseFiles,
      preserveBaseFile: true,
    });
  }

  private async getOpenedFiles(): Promise<string[]> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      logger.warn(CHANNEL, 'No workspace path found for opened files');
      return [];
    }

    // Get model names from configuration using getConfig utility
    const modelNames = getConfig<string[]>('models', []);

    const openedDocuments = workspace.textDocuments;
    const relevantFiles = openedDocuments
      .filter((doc) => doc.uri.scheme === 'file')
      .map((doc) => workspace.asRelativePath(doc.uri.fsPath, false))
      // Filter out files with names matching *_${model_name}*
      .filter((filePath) => {
        const fileName = path.basename(filePath);
        return !modelNames.some((model) => fileName.includes(`_${model}`));
      });

    logger.debug(CHANNEL, `Found opened files: ${relevantFiles.join(', ')}`);
    return relevantFiles;
  }

  private async selectOutputFiles(
    currentInputFile: string,
  ): Promise<string[] | null> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      logger.error(CHANNEL, 'No workspace folder open');
      vscode.window.showErrorMessage('No workspace folder open');
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
        defaultUri: defaultUri,
        filters: {
          'Text files': ['tex', 'txt', 'md'],
        },
      });

      if (!fileUris || fileUris.length === 0) {
        return null;
      }

      const relativePaths = fileUris.map((uri) => getRelativePath(uri.fsPath));
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

  private async handlePolishInstructionText(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    try {
      // Initialize file context with agent information
      const fileContext: FileContext = {
        agent: message.agent || undefined,
      };

      // Helper to check if a string value is valid and not empty/none
      const isValidFile = (file?: string): boolean =>
        !!file && file !== 'None' && file !== '';

      // Helper to add a single file to context if valid
      const addSingleFileIfValid = (
        contextKey: keyof FileContext,
        messageKey: string,
      ) => {
        if (isValidFile(message[messageKey])) {
          (fileContext as any)[contextKey] = message[messageKey];
        }
      };

      // Helper to add multiple files to context if valid and toggle is active
      const addMultipleFilesIfValid = (
        contextKey: keyof FileContext,
        toggleKey: string,
      ) => {
        if (
          message[toggleKey] &&
          message[contextKey] &&
          Array.isArray(message[contextKey]) &&
          message[contextKey].length > 0
        ) {
          (fileContext as any)[contextKey] = message[contextKey];
        }
      };

      // Add single files
      addSingleFileIfValid('inputFile', 'inputFile');
      addSingleFileIfValid('referenceFile', 'referenceFile');
      addSingleFileIfValid('auxiliaryFile', 'auxiliaryFile');
      addSingleFileIfValid('mediaFile', 'mediaFile');

      // Add multiple files if their toggle is active
      addMultipleFilesIfValid('inputFiles', 'inputFilesActive');
      addMultipleFilesIfValid('referenceFiles', 'referenceFilesActive');
      addMultipleFilesIfValid('auxiliaryFiles', 'auxiliaryFilesActive');
      addMultipleFilesIfValid('mediaFiles', 'mediaFilesActive');
      addMultipleFilesIfValid('outputFiles', 'outputFilesActive');

      // Show progress notification with incremental updates
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Polishing your instruction text',
          cancellable: false,
        },
        async (progress) => {
          try {
            // Initial progress update
            progress.report({ message: 'Preparing text and context...' });

            // Short delay to show first progress step
            await new Promise((resolve) => setTimeout(resolve, 300));

            // Update progress
            progress.report({
              message: 'Sending to AI for polishing...',
              increment: 30,
            });

            // Call the utility function to polish the text with file context
            const result = await polishTextWithAI(message.text, fileContext);

            // Final progress update
            progress.report({ message: 'Applying changes...', increment: 60 });

            // Short delay to show final progress step
            await new Promise((resolve) => setTimeout(resolve, 300));

            if (result.success) {
              // Send the polished text back to the webview
              webviewView.webview.postMessage({
                command: 'instructionTextPolished',
                text: result.text,
              });
            } else {
              // Show error message
              vscode.window.showErrorMessage(
                result.error || 'Error polishing text',
              );
            }
          } catch (error) {
            vscode.window.showErrorMessage(
              `Error polishing text: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            logger.error(
              CHANNEL,
              `Error in handlePolishInstructionText: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error setting up text polishing: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      logger.error(
        CHANNEL,
        `Error setting up text polishing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleUpdateFiles(
    message: any,
    webviewView: vscode.WebviewView,
  ) {
    const command = message.command;
    const fileType = command.replace('update', ''); // e.g., 'InputFiles'
    const files = message.files || [];

    logger.debug(CHANNEL, `Updating ${fileType} with ${files.length} files`);

    // Since we're just maintaining state and the files are stored in the webview state,
    // we don't need to do anything else here. The webview manages its own state
    // and we've already processed the remove action by saving it in the state.

    // Echo back the updated list to confirm receipt
    webviewView.webview.postMessage({
      command: `set${fileType}`,
      files: files,
    });
  }

  /**
   * Handle showing the agent history view
   */
  private async handleShowAgentHistory() {
    try {
      await vscode.commands.executeCommand('texra.showAgentHistory');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open agent history: ${error}`);
    }
  }
}
