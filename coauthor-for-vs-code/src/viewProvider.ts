import * as vscode from 'vscode';
import * as fs from 'fs';
import { listInputFiles, listSampleFiles, listAuxFiles, listFigureFiles, listEditedFiles } from './utils';
import * as path from 'path';
import { workspace, TextDocument } from 'vscode';

export class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) { }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview')
      ]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    // vscode.window.showInformationMessage(`HTML Content Length: ${webviewView.webview.html.length}`);

    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.command) {
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
          const task_val = message.task;
          const model_val = message.model;
          const reflect_val = message.reflect;
          const inputFile_val = message.inputFile;
          const additionalInputFiles_val = message.additionalInputFiles && message.additionalInputFiles.length > 0 ? message.additionalInputFiles : null;
          const sampleFiles_val = message.sampleFiles && message.sampleFiles.length > 0 ? message.sampleFiles : null;
          const auxFiles_val = message.auxFiles && message.auxFiles.length > 0 ? message.auxFiles : null;
          const figureFiles_val = message.figureFiles && message.figureFiles.length > 0 ? message.figureFiles : null;
          const instructions_val = message.instructions;
          const autoExtractFigure_val = message.autoExtractFigure;
          const autoExtractTikzFigure_val = message.autoExtractTikzFigure;
          const includeTikzReflection_val = message.includeTikzReflection;
          const includeTexCount_val = message.includeTexCount;
          const outputFiles_val = message.outputFiles;
          const outputNameOverride_val = message.outputNameOverride;

          vscode.commands.executeCommand('coauthor.execute', task_val, inputFile_val, auxFiles_val, instructions_val, reflect_val, model_val, figureFiles_val, additionalInputFiles_val, sampleFiles_val, autoExtractFigure_val, autoExtractTikzFigure_val, includeTikzReflection_val, includeTexCount_val, outputFiles_val, outputNameOverride_val);
          break;
        case 'selectInputFile':
        case 'selectSampleFile':
        case 'selectAuxFile':
        case 'selectFigureFile':
          const fileType = message.command.replace('select', '').toLowerCase();
          const file = await vscode.commands.executeCommand<string>(`coauthor.${message.command}`);
          if (file) {
            webviewView.webview.postMessage({ command: `${fileType}Selected`, filePath: file });
          }
          break;
        case 'selectMultipleFiles':
          const fileType = message.fileType;
          const currentFileForMultiple = message.currentFile;
          const selectedFiles = await vscode.commands.executeCommand<string[]>(`coauthor.selectMultiple${fileType}`, currentFileForMultiple);
          if (selectedFiles) {
            webviewView.webview.postMessage({ command: `setMultiple${fileType}`, files: selectedFiles });
          }
          break;
        case 'selectEditedFile':
          const editedFile = await vscode.commands.executeCommand<string>('coauthor.selectEditedFile');
          if (editedFile) {
            webviewView.webview.postMessage({ command: 'editedFileSelected', filePath: editedFile });
          }
          break;
        case 'requestInputFile':
          const inputFiles = await listInputFiles();
          webviewView.webview.postMessage({ command: 'setInputFile', files: inputFiles });
          break;
        case 'requestSampleFile':
          const sampleFiles = await listSampleFiles();
          webviewView.webview.postMessage({ command: 'setSampleFile', files: sampleFiles });
          break;
        case 'requestAuxFile':
          const auxFiles = await listAuxFiles();
          webviewView.webview.postMessage({ command: 'setAuxFile', files: auxFiles });
          break;
        case 'requestFigureFile':
          const figureFiles = await listFigureFiles();
          webviewView.webview.postMessage({ command: 'setFigureFile', files: figureFiles });
          break;
        case 'requestEditedFile':
          if (message.inputFile || message.outputNameOverride) {
            const baseFileNameForEdited = message.outputNameOverride 
              ? path.basename(message.outputNameOverride, path.extname(message.outputNameOverride))
              : path.basename(message.inputFile, path.extname(message.inputFile));
            const allEditedFiles = await listEditedFiles(baseFileNameForEdited);
            webviewView.webview.postMessage({ command: 'setEditedFiles', files: allEditedFiles });
          } else {
            vscode.window.showInformationMessage('Please select an input file or provide an output name override first.');
          }
          break;
        case 'inputFileSelected':
          vscode.window.showInformationMessage(`Selected file: ${message.filePath}`);
          const baseFileNameForInput = path.basename(message.filePath, path.extname(message.filePath));
          const filteredEditedFiles = await listEditedFiles(baseFileNameForInput);
          webviewView.webview.postMessage({ command: 'setEditedFiles', files: filteredEditedFiles });
          break;
        case 'sampleFileSelected':
        case 'auxFileSelected':
        case 'figureFileSelected':
        case 'editedFileSelected':
          vscode.window.showInformationMessage(`${message.command}: ${message.filePath}`);
          break;
        case 'modelSelected':
          // vscode.window.showInformationMessage(`Selected model: ${message.model}`);
          if (message.model) {
            webviewView.webview.postMessage({
              command: 'modelSelected',
              model: message.model
            });
          }
          break;
        case 'cleanSingle':
          vscode.commands.executeCommand('coauthor.cleanSingle', message.inputFile, message.task, message.reflect, message.model, message.outputNameOverride);
          break;
        case 'packSingle':
          vscode.commands.executeCommand('coauthor.packSingle', message.inputFile, message.task, message.reflect, message.model, message.outputNameOverride);
          break;
        case 'packMultiple':
          vscode.commands.executeCommand('coauthor.packMultiple', message.inputFile, message.additionalInputFiles, message.task, message.reflect, message.model, message.outputNameOverride, message.outputFiles);
          break;
        case 'cleanMultiple':
          vscode.commands.executeCommand('coauthor.cleanMultiple', message.inputFile, message.additionalInputFiles, message.task, message.reflect, message.model, message.outputNameOverride, message.outputFiles);
          break;
        case 'latexDiff':
          vscode.commands.executeCommand('coauthor.latexDiff', message.inputFile, message.editedFile);
          break;
        case 'latexDiffVC':
          vscode.commands.executeCommand('coauthor.latexDiffVC', message.inputFile, message.commitHash);
          break;
        case 'requestRecentCommits':
          const isGitRepo = await vscode.commands.executeCommand<boolean>('coauthor.isGitRepository');
          if (isGitRepo) {
            const commits = await vscode.commands.executeCommand<string[]>('coauthor.getRecentCommits');
            webviewView.webview.postMessage({ command: 'setRecentCommits', commits: commits });
          } else {
            webviewView.webview.postMessage({ command: 'setRecentCommits', isGitRepo: false });
          }
          break;
        case 'refreshCommits':
          const isGitRepoRefresh = await vscode.commands.executeCommand<boolean>('coauthor.isGitRepository');
          if (isGitRepoRefresh) {
            const commits_refresh = await vscode.commands.executeCommand<string[]>('coauthor.getRecentCommits');
            webviewView.webview.postMessage({ command: 'setRecentCommits', commits: commits_refresh });
          } else {
            webviewView.webview.postMessage({ command: 'setRecentCommits', isGitRepo: false });
          }
          break;
        case 'packLatexDiffVC':
          vscode.commands.executeCommand('coauthor.packLatexDiffVC', message.inputFile, message.commitHash, message.clean);
          break;
        case 'getCurrentFile':
          const currentOpenFile = await vscode.commands.executeCommand<string>('coauthor.getCurrentFile');
          if (currentOpenFile) {
            webviewView.webview.postMessage({ command: 'setCurrentFile', filePath: currentOpenFile });
          } else {
            vscode.window.showInformationMessage('No file is currently open or the file is not part of the workspace.');
          }
          break;
        case 'merge':
          vscode.commands.executeCommand('coauthor.merge', message.inputFile, message.editedFile);
          break;
        case 'getTheme':
          const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light';
          webviewView.webview.postMessage({ command: 'setTheme', theme });
          break;
        case 'setMultipleInputFiles':
        case 'setMultipleSampleFiles':
        case 'setMultipleAuxFiles':
        case 'setMultipleFigures':
          if (message.files && message.files.length > 0) {
            webviewView.webview.postMessage({ command: message.command, files: message.files });
          }
          break;
        case 'addOpenedFiles':
          const openedFiles = await this.getOpenedFiles();
          webviewView.webview.postMessage({ command: 'setOpenedFiles', files: openedFiles });
          break;
      }
    });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'index.html');
      const cssPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'styles.css');
      const jsPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'script.js');

      let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');

      const nonce = this.getNonce();
      const styleUri = webview.asWebviewUri(cssPath);
      const scriptUri = webview.asWebviewUri(jsPath);

      const config = vscode.workspace.getConfiguration('coauthor');
      const tasks = config.get<string[]>('tasks') || [];
      const taskOptions = tasks.map(task => `<option value="${task}">${task}</option>`).join('\n');

      // Replace placeholders in HTML with actual content
      return htmlContent
        .replace('${styleUri}', styleUri.toString())
        .replace('${scriptUri}', scriptUri.toString())
        .replace(/\${nonce}/g, nonce)
        .replace('${taskOptions}', taskOptions)
        .replace('${cspSource}', webview.cspSource);
    } catch (error) {
      console.error('Error generating HTML content:', error);
      return '<html><body>Error loading content</body></html>';
    }
  }

  private getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private async getOpenedFiles(): Promise<string[]> {
    const workspaceFolders = workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;

    const openedDocuments = workspace.textDocuments;
    const relevantFiles = openedDocuments
      .filter(doc => doc.uri.scheme === 'file' && (doc.languageId === 'latex' || doc.fileName.endsWith('.tex')))
      .map(doc => workspace.asRelativePath(doc.uri.fsPath, false));

    return relevantFiles;
  }
}
