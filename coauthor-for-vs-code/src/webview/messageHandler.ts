import * as vscode from 'vscode';
import * as path from 'path';
import { workspace } from 'vscode';
import { debug, info, warn, error } from '../utils/logUtils';
import { getWorkspacePath, getRelativePath } from '../utils/fileUtils';
import {
  listInputFiles,
  listReferenceFiles,
  listAuxiliaryFiles,
  listFigureFiles,
  listEditedFiles,
  getFilesIfNotEmpty,
} from '../utils';
import { capitalize, uncapitalize } from '../utils/commonUtils';

const CHANNEL = 'MessageHandler';

export class WebviewMessageHandler {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async handleMessage(message: any, webviewView: vscode.WebviewView) {
    debug(CHANNEL, `Received message: ${message.command}`);

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
      case 'setMultipleFigures':
        return this.handleSetMultipleFiles(message, webviewView);
      case 'selectMultipleFiles':
        return this.handleSelectMultipleFiles(message, webviewView);
      case 'refreshAllFiles':
        return this.handleRefreshAllFiles(webviewView);
      // Housekeeping cases
      case 'cleanOutput':
      case 'cleanBuild':
      case 'indentTex':
        return this.handleHousekeeping(message);
      case 'cleanSingle':
      case 'packSingle':
        return this.handleSingleOperation(message);
      case 'packMultiple':
      case 'cleanMultiple':
        return this.handleMultipleOperation(message);
      // Latex Diff cases
      case 'latexDiff':
        return this.handleLatexDiff(message);
      case 'latexDiffVC':
        return this.handleLatexDiffVC(message);
      case 'requestRecentCommits':
        return this.handleRequestRecentCommits(webviewView);
      case 'refreshCommits':
        return this.handleRefreshCommits(webviewView);
      case 'packLatexDiffVC':
      case 'cleanLatexDiffVC':
        return this.handleLatexDiffVCOperation(message);
      // VS Code Logic cases
      case 'getCurrentFile':
        return this.handleGetCurrentFile(message, webviewView);
      case 'addOpenedFiles':
        return this.handleAddOpenedFiles(webviewView);
    }
  }

  private async handleInfoMessage(message: any) {
    vscode.window.showInformationMessage(message.text);
    debug(CHANNEL, `Information message: ${message.text}`);
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
    const {
      agent: agent_val,
      model: model_val,
      reflect: reflect_val,
      inputFile: inputFile_val,
      referenceFile: referenceFile_val,
      auxiliaryFile: auxiliaryFile_val,
      figureFile: figureFile_val,
      inputFiles: inputFiles_raw,
      referenceFiles: referenceFiles_raw,
      auxiliaryFiles: auxiliaryFiles_raw,
      figureFiles: figureFiles_raw,
      instructions: instructions_val,
      autoExtractFigure: autoExtractFigure_val,
      autoExtractTikzFigure: autoExtractTikzFigure_val,
      autoExtractTikzFigureReflect: autoExtractTikzFigureReflect_val,
      includeTexCount: includeTexCount_val,
      outputFiles: outputFiles_val,
      outputNameOverride: outputNameOverride_val,
    } = message;

    const inputFiles_val = getFilesIfNotEmpty(inputFiles_raw);
    const referenceFiles_val = getFilesIfNotEmpty(referenceFiles_raw);
    const auxiliaryFiles_val = getFilesIfNotEmpty(auxiliaryFiles_raw);
    const figureFiles_val = getFilesIfNotEmpty(figureFiles_raw);

    if (inputFile_val || outputNameOverride_val) {
      vscode.commands.executeCommand(
        'coauthor.execute',
        agent_val,
        model_val,
        reflect_val,
        inputFile_val,
        inputFiles_val,
        referenceFile_val,
        referenceFiles_val,
        auxiliaryFile_val,
        auxiliaryFiles_val,
        figureFile_val,
        figureFiles_val,
        instructions_val,
        autoExtractFigure_val,
        autoExtractTikzFigure_val,
        autoExtractTikzFigureReflect_val,
        includeTexCount_val,
        outputFiles_val,
        outputNameOverride_val,
      );
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
    debug(CHANNEL, `Selecting ${singleFileType}`);

    const file = await vscode.commands.executeCommand<string>(
      `coauthor.${message.command}`,
    );
    if (file) {
      debug(CHANNEL, `Selected ${singleFileType}: ${file}`);
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
    vscode.window.showInformationMessage(`Selected file: ${message.filePath}`);
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
      this.postFileUpdate(
        webviewView,
        capitalize(type),
        files,
      );
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
    const operation = message.command.startsWith('pack') ? 'Packing' : 'Cleaning';
    info(
      CHANNEL,
      `${capitalize(operation)} multiple files: ${message.inputFile}, ${message.outputFiles.join(', ')}`,
    );
    vscode.commands.executeCommand(
      `coauthor.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
      message.outputNameOverride,
      message.outputFiles,
    );
  }

  private handleLatexDiff(message: any) {
    vscode.commands.executeCommand(
      'coauthor.latexDiff',
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  private handleLatexDiffVC(message: any) {
    vscode.commands.executeCommand(
      'coauthor.latexDiffVC',
      message.inputFile,
      message.baseFile,
      message.commitHash,
    );
  }

  private handleLatexDiffVCOperation(message: any) {
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
    debug(CHANNEL, `Updating base files: ${baseFiles.join(', ')}`);
    webviewView.webview.postMessage({
      command: 'setBaseFile',
      files: baseFiles,
    });
  }

  private async getOpenedFiles(): Promise<string[]> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      warn(CHANNEL, 'No workspace path found for opened files');
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

    debug(CHANNEL, `Found opened files: ${relevantFiles.join(', ')}`);
    return relevantFiles;
  }

  private async selectMultipleOutputFiles(
    currentInputFile: string,
  ): Promise<string[] | null> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      error(CHANNEL, 'No workspace folder open');
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
      info(CHANNEL, `Selected output files: ${relativePaths.join(', ')}`);
      vscode.window.showInformationMessage(
        `Selected output files: ${relativePaths.join(', ')}`,
      );
      return relativePaths;
    } catch (err) {
      error(
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
