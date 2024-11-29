import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  listInputFiles,
  listReferenceFiles,
  listAuxiliaryFiles,
  listFigureFiles,
  listEditedFiles,
  getFilesIfNotEmpty,
} from './utils';
import * as path from 'path';
import { workspace } from 'vscode';
import {
  getWorkspacePath,
  getRelativePath,
  getConfig,
} from './utils/commonUtils';
import { log, initializeLogging } from './utils/logUtils';

const CHANNEL_NAME = 'Coauthor View';
initializeLogging(CHANNEL_NAME);

export class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const category = 'Webview';
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      log(CHANNEL_NAME, category, `Received message: ${message.command}`);

      switch (message.command) {
        case 'showInformationMessage':
          vscode.window.showInformationMessage(message.text);
          log(CHANNEL_NAME, category, `Information message: ${message.text}`);
          break;
        case 'cleanOutput':
          vscode.commands.executeCommand('coauthor.cleanOutput');
          break;
        case 'cleanBuild':
          vscode.commands.executeCommand('coauthor.cleanBuild');
          break;
        case 'indentTex':
          vscode.commands.executeCommand('coauthor.indentTex');
          break;
        case 'execute':
          const agent_val = message.agent;
          const model_val = message.model;
          const reflect_val = message.reflect;
          // Get single files
          const inputFile_val = message.inputFile;
          const referenceFile_val = message.referenceFile || null;
          const auxiliaryFile_val = message.auxiliaryFile || null;
          const figureFile_val = message.figureFile || null;

          // Get multiple files
          const inputFiles_val = getFilesIfNotEmpty(message.inputFiles);
          const referenceFiles_val = getFilesIfNotEmpty(message.referenceFiles);
          const auxiliaryFiles_val = getFilesIfNotEmpty(message.auxiliaryFiles);
          const figureFiles_val = getFilesIfNotEmpty(message.figureFiles);

          const instructions_val = message.instructions;

          // tools options
          const autoExtractFigure_val = message.autoExtractFigure;
          const autoExtractTikzFigure_val = message.autoExtractTikzFigure;
          const includeTikzReflection_val = message.includeTikzReflection;
          const includeTexCount_val = message.includeTexCount;
          // output options
          const outputFiles_val = message.outputFiles;
          const outputNameOverride_val = message.outputNameOverride;

          if (inputFile_val || outputNameOverride_val) {
            vscode.commands.executeCommand(
              'coauthor.execute',
              // parameters
              agent_val,
              model_val,
              reflect_val,
              // files
              inputFile_val,
              inputFiles_val,
              referenceFile_val,
              referenceFiles_val,
              auxiliaryFile_val,
              auxiliaryFiles_val,
              figureFile_val,
              figureFiles_val,
              // instructions
              instructions_val,
              // tools options
              autoExtractFigure_val,
              autoExtractTikzFigure_val,
              includeTikzReflection_val,
              includeTexCount_val,
              // output options
              outputFiles_val,
              outputNameOverride_val,
            );
          } else {
            vscode.window.showErrorMessage(
              'Please select an input file or provide an output name override.',
            );
          }
          break;

        case 'selectInputFile':
        case 'selectReferenceFile':
        case 'selectAuxiliaryFile':
        case 'selectFigureFile':
          const singleFileType = message.command.replace('select', '');
          log(CHANNEL_NAME, category, `Selecting ${singleFileType}`);

          const file = await vscode.commands.executeCommand<string>(
            `coauthor.${message.command}`,
          );
          if (file) {
            log(CHANNEL_NAME, category, `Selected ${singleFileType}: ${file}`);
            webviewView.webview.postMessage({
              command: `${singleFileType.charAt(0).toLowerCase() + singleFileType.slice(1)}Selected`,
              filePath: file,
            });
          }
          break;
        case 'selectMultipleFiles':
          const multipleFileType = message.fileType;
          let selectedFiles: string[] | null = null;

          if (multipleFileType === 'OutputFiles') {
            selectedFiles = await this.selectMultipleOutputFiles(
              message.currentFile,
            );
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
          break;
        case 'selectEditedFile':
          const editedFile = await vscode.commands.executeCommand<string>(
            'coauthor.selectEditedFile',
          );
          if (editedFile) {
            webviewView.webview.postMessage({
              command: 'editedFileSelected',
              filePath: editedFile,
            });
          }
          break;
        case 'requestInputFile':
          {
            const refreshedInputFiles = await vscode.commands.executeCommand(
              'coauthor.refreshInputFiles',
            );
            webviewView.webview.postMessage({
              command: 'setInputFile',
              files: refreshedInputFiles,
            });
          }
          break;
        case 'requestReferenceFile':
          {
            const referenceFiles = await listReferenceFiles();
            webviewView.webview.postMessage({
              command: 'setReferenceFile',
              files: referenceFiles,
            });
          }
          break;
        case 'requestAuxiliaryFile':
          {
            const auxiliaryFiles = await listAuxiliaryFiles();
            webviewView.webview.postMessage({
              command: 'setAuxiliaryFile',
              files: auxiliaryFiles,
            });
          }
          break;
        case 'requestFigureFile':
          {
            const figureFiles = await listFigureFiles();
            webviewView.webview.postMessage({
              command: 'setFigureFile',
              files: figureFiles,
            });
          }
          break;
        case 'requestEditedFile':
          if (message.baseFile) {
            const baseFileNameForEdited = path.basename(
              message.baseFile,
              path.extname(message.baseFile),
            );
            const allEditedFiles = await listEditedFiles(baseFileNameForEdited);
            console.log('Sending edited files:', allEditedFiles);
            webviewView.webview.postMessage({
              command: 'setEditedFiles',
              files: allEditedFiles,
            });
          } else {
            webviewView.webview.postMessage({
              command: 'setEditedFiles',
              files: [],
            });
          }
          break;
        case 'refreshAllFiles':
          {
            const refreshedFiles = {
              input: await listInputFiles(),
              reference: await listReferenceFiles(),
              auxiliary: await listAuxiliaryFiles(),
              figure: await listFigureFiles(),
            };
            webviewView.webview.postMessage({
              command: 'setInputFile',
              files: refreshedFiles.input,
            });
            webviewView.webview.postMessage({
              command: 'setReferenceFile',
              files: refreshedFiles.reference,
            });
            webviewView.webview.postMessage({
              command: 'setAuxiliaryFile',
              files: refreshedFiles.auxiliary,
            });
            webviewView.webview.postMessage({
              command: 'setFigureFile',
              files: refreshedFiles.figure,
            });
            await this.updateBaseFileSelect(webviewView);
          }
          break;
        case 'inputFileSelected':
          vscode.window.showInformationMessage(
            `Selected file: ${message.filePath}`,
          );
          const baseFileNameForInput = path.basename(
            message.filePath,
            path.extname(message.filePath),
          );
          const filteredEditedFiles =
            await listEditedFiles(baseFileNameForInput);
          webviewView.webview.postMessage({
            command: 'setEditedFiles',
            files: filteredEditedFiles,
          });
          break;
        case 'referenceFileSelected':
        case 'auxiliaryFileSelected':
        case 'figureFileSelected':
        case 'editedFileSelected':
          vscode.window.showInformationMessage(
            `${message.command}: ${message.filePath}`,
          );
          break;
        case 'modelSelected':
          if (message.model) {
            webviewView.webview.postMessage({
              command: 'modelSelected',
              model: message.model,
            });
          }
          break;
        case 'cleanSingle':
          vscode.commands.executeCommand(
            'coauthor.cleanSingle',
            message.inputFile,
            message.agent,
            message.model,
            message.outputNameOverride,
          );
          break;
        case 'packSingle':
          vscode.commands.executeCommand(
            'coauthor.packSingle',
            message.inputFile,
            message.agent,
            message.model,
            message.outputNameOverride,
          );
          break;
        case 'packMultiple':
          vscode.commands.executeCommand(
            'coauthor.packMultiple',
            message.inputFile,
            message.inputFiles,
            message.agent,
            message.model,
            message.outputNameOverride,
            message.outputFiles,
          );
          break;
        case 'cleanMultiple':
          vscode.commands.executeCommand(
            'coauthor.cleanMultiple',
            message.inputFile,
            message.inputFiles,
            message.agent,
            message.model,
            message.outputNameOverride,
            message.outputFiles,
          );
          break;
        case 'latexDiff':
          vscode.commands.executeCommand(
            'coauthor.latexDiff',
            message.inputFile,
            message.baseFile,
            message.editedFile,
          );
          break;
        case 'latexDiffVC':
          vscode.commands.executeCommand(
            'coauthor.latexDiffVC',
            message.inputFile,
            message.baseFile,
            message.commitHash,
          );
          break;
        case 'requestRecentCommits':
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
          break;
        case 'refreshCommits':
          const isGitRepoRefresh =
            await vscode.commands.executeCommand<boolean>(
              'coauthor.isGitRepository',
            );
          if (isGitRepoRefresh) {
            const commits_refresh = await vscode.commands.executeCommand<
              string[]
            >('coauthor.getRecentCommits');
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
          break;
        case 'packLatexDiffVC':
          vscode.commands.executeCommand(
            'coauthor.packLatexDiffVC',
            message.inputFile,
            message.baseFile,
            message.commitHash,
            message.clean,
          );
          break;
        case 'cleanLatexDiffVC':
          vscode.commands.executeCommand(
            'coauthor.cleanLatexDiffVC',
            message.inputFile,
            message.baseFile,
            message.commitHash,
            message.clean,
          );
          break;
        case 'getCurrentFile':
          const fileType = message.fileType || 'input';
          const currentOpenFile = await vscode.commands.executeCommand<string>(
            'coauthor.getCurrentFile',
          );
          if (currentOpenFile) {
            if (fileType === 'edited') {
              const baseFile = message.baseFile;
              if (baseFile) {
                const baseFileName = path.basename(
                  baseFile,
                  path.extname(baseFile),
                );
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
          break;
        case 'merge':
          vscode.commands.executeCommand(
            'coauthor.merge',
            message.inputFile,
            message.baseFile,
            message.editedFile,
          );
          break;
        case 'getTheme':
          const theme =
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
              ? 'dark'
              : 'light';
          webviewView.webview.postMessage({ command: 'setTheme', theme });
          break;
        case 'setMultipleInputFiles':
        case 'setMultipleReferenceFiles':
        case 'setMultipleAuxiliaryFiles':
        case 'setMultipleFigures':
          if (message.files && message.files.length > 0) {
            webviewView.webview.postMessage({
              command: message.command,
              files: message.files,
            });
          }
          break;
        case 'addOpenedFiles':
          const openedFiles = await this.getOpenedFiles();
          webviewView.webview.postMessage({
            command: 'setOpenedFiles',
            files: openedFiles,
          });
          break;
        case 'requestBaseFile':
          {
            const baseFiles = await listInputFiles();
            webviewView.webview.postMessage({
              command: 'setBaseFile',
              files: baseFiles,
            });
          }
          break;
      }
    });

    webviewView.webview.postMessage({ command: 'requestBaseFile' });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'index.html',
      );
      const cssPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'styles.css',
      );
      const jsPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'script.js',
      );

      let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');

      const nonce = this.getNonce();
      const styleUri = webview.asWebviewUri(cssPath);
      const scriptUri = webview.asWebviewUri(jsPath);

      const agents = getConfig<string[]>('agents', []);
      const agentOptions = agents
        .map((agent) => `<option value="${agent}">${agent}</option>`)
        .join('\n');

      // Replace placeholders in HTML with actual content
      return htmlContent
        .replace('${styleUri}', styleUri.toString())
        .replace('${scriptUri}', scriptUri.toString())
        .replace(/\${nonce}/g, nonce)
        .replace('${agentOptions}', agentOptions)
        .replace('${cspSource}', webview.cspSource);
    } catch (error) {
      console.error('Error generating HTML content:', error);
      return '<html><body>Error loading content</body></html>';
    }
  }

  private getNonce() {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private async getOpenedFiles(): Promise<string[]> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return [];

    const openedDocuments = workspace.textDocuments;
    const relevantFiles = openedDocuments
      .filter(
        (doc) =>
          doc.uri.scheme === 'file' &&
          (doc.languageId === 'latex' || doc.fileName.endsWith('.tex')),
      )
      .map((doc) => workspace.asRelativePath(doc.uri.fsPath, false));

    return relevantFiles;
  }

  private async selectMultipleOutputFiles(
    currentInputFile: string,
  ): Promise<string[] | null> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
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
      vscode.window.showInformationMessage(
        `Selected output files: ${relativePaths.join(', ')}`,
      );
      return relativePaths;
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error selecting output files: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async updateBaseFileSelect(webviewView: vscode.WebviewView) {
    const baseFiles = await listInputFiles();
    webviewView.webview.postMessage({
      command: 'setBaseFile',
      files: baseFiles,
    });
  }
}
