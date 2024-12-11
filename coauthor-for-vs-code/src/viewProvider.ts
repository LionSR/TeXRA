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
import { debug, info, warn, error, initializeLogging } from './utils/logUtils';

const CHANNEL = 'ViewProvider';
initializeLogging(CHANNEL);

export class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      debug(CHANNEL, `Received message: ${message.command}`);

      switch (message.command) {
        case 'showInformationMessage':
          vscode.window.showInformationMessage(message.text);
          debug(CHANNEL, `Information message: ${message.text}`);
          break;
        // VS Code Logic
        case 'getTheme':
          const theme =
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
              ? 'dark'
              : 'light';
          webviewView.webview.postMessage({ command: 'setTheme', theme });
          break;
        case 'modelSelected':
          if (message.model) {
            webviewView.webview.postMessage({
              command: 'modelSelected',
              model: message.model,
            });
          }
          break;
        // Executions
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
          const autoExtractTikzFigureReflect_val =
            message.autoExtractTikzFigureReflect;
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
              autoExtractTikzFigureReflect_val,
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
        case 'merge':
          vscode.commands.executeCommand(
            `coauthor.${message.command}`,
            message.inputFile,
            message.baseFile,
            message.editedFile,
          );
          break;
        // File selection
        case 'selectInputFile':
        case 'selectReferenceFile':
        case 'selectAuxiliaryFile':
        case 'selectFigureFile':
          const singleFileType = message.command.replace('select', '');
          debug(CHANNEL, `Selecting ${singleFileType}`);

          const file = await vscode.commands.executeCommand<string>(
            `coauthor.${message.command}`,
          );
          if (file) {
            debug(CHANNEL, `Selected ${singleFileType}: ${file}`);
            webviewView.webview.postMessage({
              command: `${singleFileType.charAt(0).toLowerCase() + singleFileType.slice(1)}Selected`,
              filePath: file,
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
        // File Selected
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
          this.postFileUpdate(webviewView, 'Edited', filteredEditedFiles);
          break;
        case 'referenceFileSelected':
        case 'auxiliaryFileSelected':
        case 'figureFileSelected':
        case 'editedFileSelected':
          vscode.window.showInformationMessage(
            `${message.command}: ${message.filePath}`,
          );
          break;
        // Request File
        case 'requestInputFile':
          {
            const refreshedInputFiles =
              (await vscode.commands.executeCommand<string[]>(
                'coauthor.refreshInputFiles',
              )) || [];
            this.postFileUpdate(webviewView, 'Input', refreshedInputFiles);
          }
          break;
        case 'requestReferenceFile':
        case 'requestAuxiliaryFile':
        case 'requestFigureFile': {
          const fileType = message.command
            .replace('request', '')
            .replace('File', '');
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
          break;
        }
        case 'requestEditedFile':
          let allEditedFiles: string[] = [];
          if (message.baseFile) {
            const baseFileNameForEdited = path.basename(
              message.baseFile,
              path.extname(message.baseFile),
            );
            allEditedFiles = await listEditedFiles(baseFileNameForEdited);
            console.log('Sending edited files:', allEditedFiles);
          }
          this.postFileUpdate(webviewView, 'Edited', allEditedFiles);
          break;
        case 'requestBaseFile':
          this.postFileUpdate(webviewView, 'Base', await listInputFiles());
          break;

        // Multiple file selection
        case 'setMultipleInputFiles':
        case 'setMultipleReferenceFiles':
        case 'setMultipleAuxiliaryFiles':
        case 'setMultipleFigures':
          if (message.files?.length > 0) {
            webviewView.webview.postMessage({
              command: message.command,
              files: message.files,
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

        case 'refreshAllFiles':
          {
            const refreshedFiles = {
              input: await listInputFiles(),
              reference: await listReferenceFiles(),
              auxiliary: await listAuxiliaryFiles(),
              figure: await listFigureFiles(),
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
          break;

        // Housekeeping
        case 'cleanOutput':
        case 'cleanBuild':
        case 'indentTex':
          vscode.commands.executeCommand(`coauthor.${message.command}`);
          break;
        case 'cleanSingle':
        case 'packSingle':
          vscode.commands.executeCommand(
            `coauthor.${message.command}`,
            message.inputFile,
            message.agent,
            message.model,
            message.outputNameOverride,
          );
          break;
        case 'packMultiple':
        case 'cleanMultiple':
          vscode.commands.executeCommand(
            `coauthor.${message.command}`,
            message.inputFile,
            message.agent,
            message.model,
            message.outputNameOverride,
            message.outputFiles,
          );
          break;
        // Latex Diff
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
        case 'cleanLatexDiffVC':
          vscode.commands.executeCommand(
            `coauthor.${message.command}`,
            message.inputFile,
            message.baseFile,
            message.commitHash,
            message.clean,
          );
          break;
        // VS Code Logics
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

        case 'addOpenedFiles':
          const openedFiles = await this.getOpenedFiles();
          webviewView.webview.postMessage({
            command: 'setOpenedFiles',
            files: openedFiles,
          });
          break;
      }
    });

    webviewView.webview.postMessage({ command: 'requestBaseFile' });
  }

  private postFileUpdate(
    webviewView: vscode.WebviewView,
    fileType: string,
    files: string[],
  ) {
    webviewView.webview.postMessage({
      command: `set${fileType}File`,
      files,
    });
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
      debug(CHANNEL, 'Generated HTML content for webview');
      return htmlContent
        .replace('${styleUri}', styleUri.toString())
        .replace('${scriptUri}', scriptUri.toString())
        .replace(/\${nonce}/g, nonce)
        .replace('${agentOptions}', agentOptions)
        .replace('${cspSource}', webview.cspSource);
    } catch (err) {
      error(
        CHANNEL,
        `Error generating HTML content: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  private async updateBaseFileSelect(webviewView: vscode.WebviewView) {
    const baseFiles = await listInputFiles();
    debug(CHANNEL, `Updating base files: ${baseFiles.join(', ')}`);
    webviewView.webview.postMessage({
      command: 'setBaseFile',
      files: baseFiles,
    });
  }
}
