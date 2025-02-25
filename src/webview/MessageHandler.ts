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
import {
  listInputFiles,
  listReferenceFiles,
  listAuxiliaryFiles,
  listFigureFiles,
  listEditedFiles,
  getFilesIfNotEmpty,
} from '../frontend-utils/fileListingUtils';

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
      // File selection cases
      case 'selectInputFile':
      case 'selectReferenceFile':
      case 'selectAuxiliaryFile':
      case 'selectFigureFile':
        return this.handleFileSelection(message, webviewView);
      case 'selectEditedFile':
        return this.handleEditedFileSelection(webviewView);
      // File Selected cases
      case 'inputFileSelected':
        return this.handleInputFileSelected(message, webviewView);
      case 'referenceFileSelected':
      case 'auxiliaryFileSelected':
      case 'figureFileSelected':
      case 'editedFileSelected':
        return this.handleGenericFileSelected(message);
      // Request File cases
      case 'requestInputFile':
        return this.handleRequestInputFile(webviewView);
      case 'requestReferenceFile':
      case 'requestAuxiliaryFile':
      case 'requestFigureFile':
        return this.handleRequestFile(message, webviewView);
      case 'requestEditedFile':
        return this.handleRequestEditedFile(message, webviewView);
      case 'requestBaseFile':
        return this.handleRequestBaseFile(webviewView);
      // Multiple file selection cases
      case 'setMultipleInputFiles':
      case 'setMultipleReferenceFiles':
      case 'setMultipleAuxiliaryFiles':
      case 'setMultipleFigureFiles':
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
        return this.handleAddOpenedFiles(webviewView);
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
        autoExtractFigure: message.autoExtractFigure,
        autoExtractTikzFigure: message.autoExtractTikzFigure,
        autoExtractTikzFigureReflect: message.autoExtractTikzFigureReflect,
        attachTeXCount: message.attachTeXCount,
        usePrefillFromInput: message.usePrefillFromInput,
        autoConfirmation: message.autoConfirmation,
        printInputPrompt: message.printInputPrompt,
      };

      const agentConfig: AgentConfig = {
        agent: message.agent,
        model: message.model,
        reflect: message.reflect === 'True',
        instruction: message.instruction,
        inputFile: message.inputFile,
        inputFiles: getFilesIfNotEmpty(message.inputFiles),
        referenceFile: message.referenceFile,
        referenceFiles: getFilesIfNotEmpty(message.referenceFiles),
        auxiliaryFile: message.auxiliaryFile,
        auxiliaryFiles: getFilesIfNotEmpty(message.auxiliaryFiles),
        figureFile: message.figureFile,
        figureFiles: getFilesIfNotEmpty(message.figureFiles),
        outputFiles: getFilesIfNotEmpty(message.outputFiles),
        outputNameOverride: message.outputNameOverride,
        editedFile: null,
        toolConfig,
      };

      vscode.commands.executeCommand('coauthor.execute', agentConfig);
    } else {
      vscode.window.showErrorMessage(
        'Please select an input file or provide an output name override.',
      );
    }
  }

  private async handleMerge(message: any) {
    vscode.commands.executeCommand(
      `coauthor.${message.command}`,
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
      `coauthor.${message.command}`,
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
      'coauthor.selectEditedFile',
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
        'coauthor.refreshInputFiles',
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
        case 'Figure':
          return await listFigureFiles();
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
    const multipleFileType = message.fileType;
    let selectedFiles: string[] | null = null;

    if (multipleFileType === 'OutputFiles') {
      selectedFiles = await this.selectMultipleOutputFiles(message.currentFile);
    } else {
      const currentFileForMultiple = message.currentFile;
      selectedFiles = await vscode.commands.executeCommand<string[]>(
        `coauthor.selectMultiple${multipleFileType}`,
        currentFileForMultiple,
      );
    }

    if (selectedFiles) {
      webviewView.webview.postMessage({
        command: `setMultiple${multipleFileType}`,
        files: selectedFiles,
      });
    }
  }

  private async handleRefreshAllFiles(webviewView: vscode.WebviewView) {
    const refreshedFiles = {
      input: await listInputFiles(),
      reference: await listReferenceFiles(),
      auxiliary: await listAuxiliaryFiles(),
      figure: await listFigureFiles(),
    };

    Object.entries(refreshedFiles).forEach(([type, files]) => {
      this.postFileUpdate(webviewView, capitalize(type), files);
    });

    await this.updateBaseFileSelect(webviewView);
  }

  private handleHousekeeping(message: any) {
    vscode.commands.executeCommand(`coauthor.${message.command}`);
  }

  private handleSingleOperation(message: any) {
    vscode.commands.executeCommand(
      `coauthor.${message.command}`,
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
      `coauthor.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
      message.outputFiles,
      message.outputNameOverride,
    );
  }

  private handleLatexdiff(message: any) {
    vscode.commands.executeCommand(
      'coauthor.latexdiff',
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  private handleLatexdiffvc(message: any) {
    vscode.commands.executeCommand(
      'coauthor.latexdiffvc',
      message.inputFile,
      message.baseFile,
      message.commitHash,
    );
  }

  private handleLatexdiffvcOperation(message: any) {
    vscode.commands.executeCommand(
      `coauthor.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.commitHash,
      message.clean,
    );
  }

  private async handleRequestRecentCommits(webviewView: vscode.WebviewView) {
    const isGitRepo = await vscode.commands.executeCommand<boolean>(
      'coauthor.isGitRepository',
    );
    const commits = isGitRepo
      ? await vscode.commands.executeCommand<string[]>(
          'coauthor.getRecentCommits',
        )
      : [];
    webviewView.webview.postMessage({
      command: 'setRecentCommits',
      commits,
      isGitRepo,
    });
  }

  private async handleRefreshCommits(webviewView: vscode.WebviewView) {
    const isGitRepoRefresh = await vscode.commands.executeCommand<boolean>(
      'coauthor.isGitRepository',
    );
    if (isGitRepoRefresh) {
      const commits_refresh = await vscode.commands.executeCommand<string[]>(
        'coauthor.getRecentCommits',
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
      'coauthor.getCurrentFile',
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

  private async handleAddOpenedFiles(webviewView: vscode.WebviewView) {
    const openedFiles = await this.getOpenedFiles();
    webviewView.webview.postMessage({
      command: 'setOpenedFiles',
      files: openedFiles,
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

    const openedDocuments = workspace.textDocuments;
    const relevantFiles = openedDocuments
      .filter(
        (doc) =>
          doc.uri.scheme === 'file' &&
          (doc.languageId === 'latex' || doc.fileName.endsWith('.tex')),
      )
      .map((doc) => workspace.asRelativePath(doc.uri.fsPath, false));

    logger.debug(CHANNEL, `Found opened files: ${relevantFiles.join(', ')}`);
    return relevantFiles;
  }

  private async selectMultipleOutputFiles(
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

      if (!fileUris || fileUris.length === 0) return null;

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
}
