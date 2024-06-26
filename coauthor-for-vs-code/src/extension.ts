/* The module 'vscode' contains the VS Code extensibility API
 * Import the module and reference it with the alias vscode in your code below
 */
import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  let terminal: vscode.Terminal | undefined;

  function ensureTerminal() {
    // Check if the terminal already exists
    const existingTerminal = vscode.window.terminals.find(t => t.name === 'housekeeping');
    if (existingTerminal) {
      terminal = existingTerminal;
    } else if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal('housekeeping');
    }
    return terminal;
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.selectMultipleFiles', async (currentInputFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      const defaultUri = currentInputFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentInputFile)))
        : vscode.Uri.file(workspacePath);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Files',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Text files': ['tex']
        }
      });
      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => path.relative(workspacePath, uri.fsPath));
        vscode.window.showInformationMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleAuxFiles', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;
    
      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Auxiliary Files',
        canSelectFiles: true,
        canSelectFolders: false,
        filters: {
          'Text files': ['txt', 'tex', 'cls']
        }
      });
      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => path.relative(workspacePath, uri.fsPath));
        vscode.window.showInformationMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleFigures', async (currentFigureFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      // Get the configuration
      const config = vscode.workspace.getConfiguration('coauthor');
      const includeDirectories = config.get<string[]>('includedDirectories') || ['Discrete-Time', 'FiguresEx'];

      const defaultUri = currentFigureFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentFigureFile)))
        : vscode.Uri.file(workspacePath);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Figures',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Image files': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'pdf']
        }
      });

      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => {
          const relativePath = path.relative(workspacePath, uri.fsPath);
          const pathParts = relativePath.split(path.sep);

          const startIndex = pathParts.findIndex(part => includeDirectories.includes(part));

          if (startIndex !== -1) {
            return pathParts.slice(startIndex).join(path.sep);
          }

          return relativePath;
        });

        vscode.window.showInformationMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.packSingle', (inputFilePath: string, task: string, reflect: string, model: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText(`coauthor pack-single ${inputFilePath} --task=${task} --reflect=${reflect} --model=${model}`);
    }),
    vscode.commands.registerCommand('coauthor.packLatexDiffVC', async (inputFilePath: string, commitHash: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText(`coauthor pack-latexdiff-vc ${inputFilePath} ${commitHash}`);
    }),
    vscode.commands.registerCommand('coauthor.cleanOutput', () => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText("coauthor clean-output");
    }),
    vscode.commands.registerCommand('coauthor.cleanBuild', () => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText("coauthor clean-build");
    }),
    vscode.commands.registerCommand('coauthor.indentTex', () => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText("coauthor indent-tex");
    }),
    vscode.commands.registerCommand('coauthor.cleanSingle', (inputFilePath: string, task: string, reflect: string, model: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText(`coauthor clean-single ${inputFilePath} --task=${task} --reflect=${reflect} --model=${model}`);
    }),
    vscode.commands.registerCommand('coauthor.latexDiff', (inputFilePath: string, revisionFilePath: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const revisionFileName = revisionFilePath.split('/').pop();
      const baseName = revisionFileName?.split('.').slice(0, -1).join('.');
      const diffFileName = `${baseName}_diff.tex`;
      const inputSubdirectory = inputFilePath.substring(0, inputFilePath.lastIndexOf('/'));
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);

      terminal.sendText(`coauthor latexdiff ${inputFilePath} ${revisionFilePath}`);

      // Wait for the command to execute and the file to be generated
      setTimeout(async () => {
        try {
          await vscode.workspace.fs.stat(fullPath);
          vscode.window.showTextDocument(fullPath);
          await vscode.commands.executeCommand('workbench.view.extension.latex-workshop-activitybar');
          await vscode.commands.executeCommand('latex-workshop.build');
          setTimeout(async () => {
            await vscode.commands.executeCommand('latex-workshop.view');
          }, 5000); // Adjust the delay based on expected build time
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            vscode.window.showErrorMessage('Diff file could not be found. Expected path: ' + fullPath.fsPath);
          } else if (error instanceof Error) {
            vscode.window.showErrorMessage('An error occurred: ' + error.message);
          } else {
            vscode.window.showErrorMessage('An unknown error occurred.');
          }
        }
      }, 2000); // Adjust delay as needed based on expected command execution time
    }),
    vscode.commands.registerCommand('coauthor.latexDiffVC', async (inputFilePath: string, commitHash: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const inputFileName = inputFilePath.split('/').pop();
      const baseName = inputFileName?.split('.').slice(0, -1).join('.');
      const diffFileName = `${baseName}-diff${commitHash}.tex`;
      const inputSubdirectory = inputFilePath.substring(0, inputFilePath.lastIndexOf('/'));
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);

      // terminal.sendText(`latexdiff-vc --force --flatten --git -r ${commitHash} ${inputFilePath}`);
      terminal.sendText(`coauthor latexdiff-vc ${inputFilePath} ${commitHash}`);

      // Wait for the command to execute and the file to be generated
      setTimeout(async () => {
        try {
          await vscode.workspace.fs.stat(fullPath);
          vscode.window.showTextDocument(fullPath);
          await vscode.commands.executeCommand('workbench.view.extension.latex-workshop-activitybar');
          await vscode.commands.executeCommand('latex-workshop.build');
          setTimeout(async () => {
            await vscode.commands.executeCommand('latex-workshop.view');
          }, 5000); // Adjust the delay based on expected build time
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            vscode.window.showErrorMessage('Diff file could not be found. Expected path: ' + fullPath.fsPath);
          } else if (error instanceof Error) {
            vscode.window.showErrorMessage('An error occurred: ' + error.message);
          } else {
            vscode.window.showErrorMessage('An unknown error occurred.');
          }
        }
      }, 2000); // Adjust delay as needed based on expected command execution time
    }),
    vscode.commands.registerCommand('coauthor.getRecentCommits', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        return new Promise<string[]>((resolve, reject) => {
          exec('git log -n 20 --pretty=format:"%h: %s"', { cwd: workspacePath }, (error, stdout, stderr) => {
            if (error) {
              vscode.window.showErrorMessage(`Error fetching commits: ${stderr}`);
              reject(stderr);
            } else {
              const commits = stdout.split('\n').map(line => line.trim());
              // Add "HEAD" as the first option
              commits.unshift("HEAD");
              resolve(commits);
            }
          });
        });
      }
      return [];
    }),
    vscode.commands.registerCommand('coauthor.execute', (task: string, inputFilePath: string, auxFiles: string | string[], instructions: string, reflect: string, model: string, figureFiles: string | string[], additionalInputFiles: string[], autoExtractFigure: boolean, includeTexCount: boolean) => {
      const terminalName = `${task}@${model}`;
      const terminal_new = vscode.window.createTerminal(terminalName);
      terminal_new.show();

      let command = `coauthor ${task} ${inputFilePath}`;
      
      if (additionalInputFiles && additionalInputFiles.length > 0) {
        command += ` --input_files="${additionalInputFiles.join(',')}"`;
      }
      if (auxFiles) {
        const auxFileList = Array.isArray(auxFiles) ? auxFiles : [auxFiles];
        if (auxFileList.length === 1) {
          command += ` --auxiliary_files="${auxFileList[0]}"`;
        } else if (auxFileList.length > 1) {
          command += ` --auxiliary_files="${auxFileList.join(',')}"`;
        }
      }

      if (figureFiles) {
        const figureFileList = Array.isArray(figureFiles) ? figureFiles : [figureFiles];
        if (figureFileList.length === 1) {
          command += ` --figure_inputs="${figureFileList[0]}"`;
        } else if (figureFileList.length > 1) {
          command += ` --figure_inputs="${figureFileList.join(',')}"`;
        }
      }

      if (instructions) {
        const escapedInstructions = instructions
          .replace(/\\/g, '\\\\')  // Escape backslashes
          .replace(/"/g, '\\"')  // Escape double quotes
          .replace(/{/g, '\\{')  // Escape curly braces
          .replace(/}/g, '\\}');  // Escape curly braces
        command += ` --instruction="${escapedInstructions}"`;
      }
      if (model) {
        command += ` --model=${model}`;
      }
      if (reflect !== 'default') {
        command += ` --reflect=${reflect}`;
      }

      if (autoExtractFigure) {
        command += ' --auto_extract_figure';
      }
      if (includeTexCount) {
        command += ' --include_tex_count';
      }

      terminal_new.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.selectInputFile', async (currentInputFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      const defaultUri = currentInputFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentInputFile)))
        : vscode.Uri.file(workspacePath);

      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select File',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Text files': ['tex', 'txt']
        }
      });
      if (fileUri && fileUri[0]) {
        const relativePath = path.relative(workspacePath, fileUri[0].fsPath);
        vscode.window.showInformationMessage(`Selected file: ${relativePath}`);
        return relativePath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectFigureFile', async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Figure File',
        canSelectFiles: true,
        canSelectFolders: false,
        filters: {
          'Images': ['png', 'pdf', 'jpeg']
        }
      });
      if (fileUri && fileUri[0]) {
        vscode.window.showInformationMessage(`Selected figure file: ${fileUri[0].fsPath}`);
        return fileUri[0].fsPath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectRevisionFile', async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Revision File',
        canSelectFiles: true,
        canSelectFolders: false
      });
      if (fileUri && fileUri[0]) {
        vscode.window.showInformationMessage(`Selected revision file: ${fileUri[0].fsPath}`);
        return fileUri[0].fsPath;
      }
      return null;
    }),
    vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context))
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'coauthor.chatView',
      new CoAuthorViewProvider(context)
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }

class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) { }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getWebviewContent();

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
          const inputFilePath_val = message.inputFilePath;
          const auxFiles_val = message.auxFiles;
          const instructions_val = message.instructions;
          const reflect_val = message.reflect;
          const model_val = message.model;
          const additionalInputFiles_val = message.additionalInputFiles;
          const figureFiles_val = message.figureFiles;
          const autoExtractFigure_val = message.autoExtractFigure;
          const includeTexCount_val = message.includeTexCount;

          vscode.commands.executeCommand('coauthor.execute', task_val, inputFilePath_val, auxFiles_val, instructions_val, reflect_val, model_val, figureFiles_val, additionalInputFiles_val, autoExtractFigure_val, includeTexCount_val);
          break;
        case 'selectInputFile':
          const inputFilePath = await vscode.commands.executeCommand<string>('coauthor.selectInputFile');
          if (inputFilePath) {
            webviewView.webview.postMessage({ command: 'inputFileSelected', filePath: inputFilePath });
          }
          break;
        case 'selectAuxFile':
          const auxFilePath = await vscode.commands.executeCommand<string>('coauthor.selectAuxFile');
          if (auxFilePath) {
            webviewView.webview.postMessage({ command: 'auxFileSelected', filePath: auxFilePath });
          }
          break;
        case 'selectFigureFile':
          const figureFilePath = await vscode.commands.executeCommand<string>('coauthor.selectFigureFile');
          if (figureFilePath) {
            webviewView.webview.postMessage({ command: 'figureFileSelected', filePath: figureFilePath });
          }
          break;
        case 'selectMultipleFiles':
          const multipleFilesSelect = await vscode.commands.executeCommand<string[]>('coauthor.selectMultipleFiles', message.currentInputFile);
          if (multipleFilesSelect) {
            webviewView.webview.postMessage({ command: 'setMultipleFiles', files: multipleFilesSelect });
          }
          break;
        case 'selectMultipleAuxFiles':
          const multipleAuxFilesSelect = await vscode.commands.executeCommand<string[]>('coauthor.selectMultipleAuxFiles');
          if (multipleAuxFilesSelect) {
            webviewView.webview.postMessage({ command: 'setMultipleAuxFiles', files: multipleAuxFilesSelect });
          }
          break;
        case 'selectMultipleFigures':
          const multipleFiguresSelect = await vscode.commands.executeCommand<string[]>('coauthor.selectMultipleFigures', message.currentFigureFile);
          if (multipleFiguresSelect) {
            webviewView.webview.postMessage({ command: 'setMultipleFigures', files: multipleFiguresSelect });
          }
          break;
        case 'selectRevisionFile':
          const revisionFilePath = await vscode.commands.executeCommand<string>('coauthor.selectRevisionFile');
          if (revisionFilePath) {
            webviewView.webview.postMessage({ command: 'revisionFileSelected', filePath: revisionFilePath });
          }
          break;
        case 'requestInputFile':
          const files = await this.listInputFiles();
          webviewView.webview.postMessage({ command: 'setInputFile', files: files });
          break;
        case 'requestAuxFile':
          const auxFiles = await this.listAuxFiles();
          webviewView.webview.postMessage({ command: 'setAuxFile', files: auxFiles });
          break;
        case 'requestFigureFile':
          const figureFiles = await this.listFigureFiles();
          webviewView.webview.postMessage({ command: 'setFigureFile', files: figureFiles });
          break;
        case 'requestRevisionFile':
          const allRevisionFiles = await this.listRevisionFiles(message.inputFilePath);
          webviewView.webview.postMessage({ command: 'setRevisionFiles', files: allRevisionFiles });
          break;
        case 'inputFileSelected':
          vscode.window.showInformationMessage(`Selected file: ${message.filePath}`);
          const filteredRevisionFiles = await this.listRevisionFiles(message.filePath);
          webviewView.webview.postMessage({ command: 'setRevisionFiles', files: filteredRevisionFiles });
          break;
        case 'auxFileSelected':
          vscode.window.showInformationMessage(`Selected auxiliary file: ${message.filePath}`);
          break;
        case 'figureFileSelected':
          vscode.window.showInformationMessage(`Selected figure file: ${message.filePath}`);
          break;
        case 'revisionFileSelected':
          vscode.window.showInformationMessage(`Selected revision file: ${message.filePath}`);
          break;
        case 'modelSelect':
          vscode.window.showInformationMessage(`Selected model: ${message.model}`);
          if (message.model) {
            webviewView.webview.postMessage({
              command: 'modelSelected',
              model: message.model
            });
          }
          break;
        case 'cleanSingle':
          vscode.commands.executeCommand('coauthor.cleanSingle', message.inputFilePath, message.task, message.reflect, message.model);
          break;
        case 'packSingle':
          vscode.commands.executeCommand('coauthor.packSingle', message.inputFilePath, message.task, message.reflect, message.model);
          break;
        case 'latexDiff':
          vscode.commands.executeCommand('coauthor.latexDiff', message.inputFilePath, message.revisionFilePath);
          break;
        case 'latexDiffVC':
          vscode.commands.executeCommand('coauthor.latexDiffVC', message.inputFilePath, message.commitHash);
          break;
        case 'requestRecentCommits':
          const commits = await vscode.commands.executeCommand<string[]>('coauthor.getRecentCommits');
          webviewView.webview.postMessage({ command: 'setRecentCommits', commits: commits });
          break;
        case 'refreshCommits':
          const commits_refresh = await vscode.commands.executeCommand<string[]>('coauthor.getRecentCommits');
          webviewView.webview.postMessage({ command: 'setRecentCommits', commits: commits_refresh });
          break;
        case 'packLatexDiffVC':
          vscode.commands.executeCommand('coauthor.packLatexDiffVC', message.inputFilePath, message.commitHash);
          break;
      }
    });
  }

  private async listInputFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['build', 'node_modules', 'figures', 'Figs', '__pycache__', 'Figures', 'figs', "Versions"], ['_log_', 'Makefile', 'template', '_log', '_diff', 'command.tex', 'preamble.tex']);
    }
    return [];
  }

  private async listAuxFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesInDirectory(workspacePath, ['.txt', '.tex', '.cls'], ['.bst', '.bib', '.pdf', '.sty', '.py', '.json', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['_log_', 'Makefile', 'template', '_log', '_diff']);
    }
    return [];
  }

  private async listFigureFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesRecursively(workspacePath, workspacePath, ['.png', '.pdf', '.jpeg'], ['.txt', '.tex', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.vslx', '.ts', '.js'], ['build', 'node_modules', '__pycache__', "Versions"], ['_log', 'Makefile', 'template', '_diff']);
    }
    return [];
  }

  private async listRevisionFiles(inputFileName?: string): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      const files = await this.getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['build', 'node_modules', 'figures', 'Figs', '__pycache__', 'Figures', 'figs', "Versions"], ['_log_', 'Makefile', 'template', '_log', '_diff', 'command.tex']);
      if (inputFileName) {
        const inputFileBaseName = inputFileName.split('.').slice(0, -1).join('.');
        return files.filter(file => file.startsWith(inputFileBaseName) && file !== inputFileName);
      }
      return files;
    }
    return [];
  }

  private async getFilesInDirectory(dir: string, includeExtensions: string[] = [], excludeExtensions: string[] = [], excludeKeywords: string[] = []): Promise<string[]> {
    const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return dirEntries
      .filter(([name, type]) =>
        type === vscode.FileType.File &&
        !name.startsWith('.') &&
        (includeExtensions.length === 0 || includeExtensions.some(ext => name.endsWith(ext))) &&
        !excludeExtensions.some(ext => name.endsWith(ext)) &&
        !excludeKeywords.some(keyword => name.includes(keyword))
      )
      .map(([name]) => name);
  }

  private async getFilesRecursively(dir: string, root: string, includeExtensions: string[] = [], excludeExtensions: string[] = [], excludeDirectories: string[] = [], excludeKeywords: string[] = []): Promise<string[]> {
    const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    const files = await Promise.all(dirEntries.map(async ([name, type]) => {
      const fullPath = `${dir}/${name}`;
      const relativePath = fullPath.replace(`${root}/`, '');

      // Check if the entry is a symbolic link
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
      const isSymbolicLink = (stat.type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;

      if ((type === vscode.FileType.Directory || isSymbolicLink) && !name.startsWith('.') && !excludeDirectories.includes(name)) {
        // If it's a directory or a symbolic link, recursively process it
        return await this.getFilesRecursively(fullPath, root, includeExtensions, excludeExtensions, excludeDirectories, excludeKeywords);
      } else if (type === vscode.FileType.File && !name.startsWith('.') &&
        (includeExtensions.length === 0 || includeExtensions.some(ext => name.endsWith(ext))) &&
        !excludeExtensions.some(ext => name.endsWith(ext)) &&
        !excludeKeywords.some(keyword => name.includes(keyword))) {
        return [relativePath];
      } else {
        return [];
      }
    }));
    return files.flat();
  }

  private getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CoAuthor Panel</title>
      <style>
      select#inputFileSelect,
      select#auxFileSelect,
      select#figureFileSelect,
      select#revisionFileSelect,
      select#commitSelect {
        width: 100%;
      }
      #multipleFilesSelect,
      #multipleAuxFilesSelect,
      #multipleFiguresSelect {
        margin-top: 10px;
        padding: 5px;
        border: 1px solid #ccc;
        max-height: 100px;
        overflow-y: auto;
        background-color: #f0f0f0;
      }
      #multipleFilesSelect div,
      #multipleAuxFilesSelect div,
      #multipleFiguresSelect div {
        margin-bottom: 2px;
        padding: 2px;
        background-color: #ffffff;
      }
      .remove-button {
        margin-left: 10px;
        color: red;
        cursor: pointer;
      }
      </style>
      <script>
        const vscode = acquireVsCodeApi();

        function addFileToList(containerId, file) {
          const container = document.getElementById(containerId);
          const fileElement = document.createElement('div');
          fileElement.textContent = file;
          const removeButton = document.createElement('span');
          removeButton.textContent = ' -';
          removeButton.className = 'remove-button';
          removeButton.addEventListener('click', () => {
            container.removeChild(fileElement);
            saveState();
          });
          fileElement.appendChild(removeButton);
          container.appendChild(fileElement);
        }

        function getSelectedFiles(multipleFilesSelectDiv) {
          const fileElements = multipleFilesSelectDiv.getElementsByTagName('div');
          return Array.from(fileElements).map(el => el.textContent.replace(' -', '') || '');
        }

        window.onload = function() {
          vscode.postMessage({ command: 'requestInputFile' });
          vscode.postMessage({ command: 'requestAuxFile' });
          vscode.postMessage({ command: 'requestFigureFile' });
          vscode.postMessage({ command: 'requestRevisionFile' });
          vscode.postMessage({ command: 'requestRecentCommits' });
          // Restore previous state
          restoreState();
        };        
        document.addEventListener('DOMContentLoaded', function() {
          document.getElementById('taskSelect').addEventListener('change', function() {
            const selectedTask = this.value;
            if (selectedTask.startsWith('correct')) {
              document.getElementById('figureFileSelect').value = '';
              document.getElementById('reflectSelect').value = 'False';
            } else {
              // Refresh the figure file options
              vscode.postMessage({ command: 'requestFigureFile' });
            }
            saveState();
          });
          document.getElementById('modelSelect').addEventListener('change', function() {
            vscode.postMessage({
              command: 'modelSelect',
              model: this.value
            });
          });
          document.getElementById('inputFileSelect').addEventListener('change', function() {
            const inputFilePath = this.value;
            vscode.postMessage({
              command: 'inputFileSelected',
              filePath: inputFilePath
            });
          });
          document.getElementById('selectMultipleFilesButton').addEventListener('click', function() {
            const currentInputFile = document.getElementById('inputFileSelect').value;
            vscode.postMessage({
              command: 'selectMultipleFiles',
              currentInputFile: currentInputFile
            });
          });
          document.getElementById('selectMultipleFiguresButton').addEventListener('click', function() {
            const currentFigureFile = document.getElementById('figureFileSelect').value;
            vscode.postMessage({
              command: 'selectMultipleFigures',
              currentFigureFile: currentFigureFile
            });
          });
          document.getElementById('emptyMultipleFilesButton').addEventListener('click', function() {
            const multipleFilesSelectDiv = document.getElementById('multipleFilesSelect');
            multipleFilesSelectDiv.innerHTML = '';
            multipleFilesSelectDiv.style.display = 'none';
            saveState();
          });
          document.getElementById('autoExtractFigure').addEventListener('change', (event) => {
            const isChecked = event.target.checked;
            vscode.postMessage({ command: 'updateAutoExtractFigure', value: isChecked });
          });
          document.getElementById('selectMultipleAuxFilesButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'selectMultipleAuxFiles'
            });
          });
          document.getElementById('emptyMultipleFiguresButton').addEventListener('click', function() {
            const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
            multipleFiguresSelectDiv.innerHTML = '';
            multipleFiguresSelectDiv.style.display = 'none';
            saveState();
          });
          document.getElementById('emptyMultipleAuxFilesButton').addEventListener('click', function() {
            const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
            multipleAuxFilesSelectDiv.innerHTML = '';
            multipleAuxFilesSelectDiv.style.display = 'none';
            saveState();
          });
          document.getElementById('cleanOutputButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'cleanOutput'
            });
          });
          document.getElementById('cleanBuildButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'cleanBuild'
            });
          });
          document.getElementById('indentTexButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'indentTex'
            });
          });
          document.getElementById('executeButton').addEventListener('click', function() {
            const task = document.getElementById('taskSelect').value;
            const inputFilePath = document.getElementById('inputFileSelect').value;
            const auxFilePath = document.getElementById('auxFileSelect').value;
            const figureFilePath = document.getElementById('figureFileSelect').value;
            const instructions = document.getElementById('taskInput').value;
            const reflect = document.getElementById('reflectSelect').value;
            const model = document.getElementById('modelSelect').value;
            const autoExtractFigure = document.getElementById('autoExtractFigure').checked;
            const includeTexCount = document.getElementById('includeTexCount').checked;
          
            // Get additional input files
            const multipleFilesSelectDiv = document.getElementById('multipleFilesSelect');
            const additionalInputFiles = getSelectedFiles(multipleFilesSelectDiv).filter(file => file !== inputFilePath);
          
            // Get auxiliary files
            const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
            const multipleAuxFiles = getSelectedFiles(multipleAuxFilesSelectDiv);
            const auxFiles = multipleAuxFiles.length > 0 ? multipleAuxFiles : (auxFilePath ? [auxFilePath] : []);
            
            // Get figure files
            const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
            const multipleFigures = getSelectedFiles(multipleFiguresSelectDiv);
            const figureFiles = multipleFigures.length > 0 ? multipleFigures : (figureFilePath ? [figureFilePath] : []);
                    
            vscode.postMessage({
              command: 'execute',
              task: task,
              inputFilePath: inputFilePath,
              additionalInputFiles: additionalInputFiles,
              auxFiles: auxFiles,
              figureFiles: figureFiles,
              instructions: instructions,
              reflect: reflect,
              model: model,
              autoExtractFigure: autoExtractFigure,
              includeTexCount: includeTexCount,
            });
          });
          document.getElementById('packSingleButton').addEventListener('click', function() {
            const inputFilePath = document.getElementById('inputFileSelect').value;
            const task = document.getElementById('taskSelect').value;
            const reflect = document.getElementById('reflectSelect').value;
            const model = document.getElementById('modelSelect').value;
            vscode.postMessage({
              command: 'packSingle',
              inputFilePath: inputFilePath,
              task: task,
              reflect: reflect,
              model: model
            });
          });
          document.getElementById('cleanSingleButton').addEventListener('click', function() {
            const inputFilePath = document.getElementById('inputFileSelect').value;
            const task = document.getElementById('taskSelect').value;
            const reflect = document.getElementById('reflectSelect').value;
            const model = document.getElementById('modelSelect').value;
            vscode.postMessage({
              command: 'cleanSingle',
              inputFilePath: inputFilePath,
              task: task,
              reflect: reflect,
              model: model
            });
          });
          document.getElementById('latexDiffButton').addEventListener('click', function() {
            const inputFilePath = document.getElementById('inputFileSelect').value;
            const revisionFilePath = document.getElementById('revisionFileSelect').value;
            vscode.postMessage({
              command: 'latexDiff',
              inputFilePath: inputFilePath,
              revisionFilePath: revisionFilePath
            });
          });
          document.getElementById('latexDiffVCButton').addEventListener('click', function() {
            const inputFilePath = document.getElementById('inputFileSelect').value;
            const commitHash = document.getElementById('commitSelect').value;
            vscode.postMessage({
              command: 'latexDiffVC',
              inputFilePath: inputFilePath,
              commitHash: commitHash
            });
          });
          document.getElementById('refreshCommitsButton').addEventListener('click', function() {
            vscode.postMessage({
                command: 'refreshCommits'
            });
          });
          document.getElementById('packLatexDiffVCButton').addEventListener('click', function() {
            const inputFilePath = document.getElementById('inputFileSelect').value;
            const commitHash = document.getElementById('commitSelect').value;
            vscode.postMessage({
              command: 'packLatexDiffVC',
              inputFilePath: inputFilePath,
              commitHash: commitHash
            });
          });

          // Save state on input changes
          document.getElementById('modelSelect').addEventListener('change', saveState);
          document.getElementById('taskSelect').addEventListener('change', saveState);
          document.getElementById('inputFileSelect').addEventListener('change', saveState);
          document.getElementById('auxFileSelect').addEventListener('change', saveState);
          document.getElementById('figureFileSelect').addEventListener('change', saveState);
          document.getElementById('revisionFileSelect').addEventListener('change', saveState);
          document.getElementById('taskInput').addEventListener('input', saveState);
          document.getElementById('reflectSelect').addEventListener('change', saveState);
          document.getElementById('commitSelect').addEventListener('change', saveState);
          document.getElementById('autoExtractFigure').addEventListener('change', saveState);
          document.getElementById('includeTexCount').addEventListener('change', saveState);
        });

        function saveState() {
          const state = {
            modelSelect: document.getElementById('modelSelect').value,
            taskSelect: document.getElementById('taskSelect').value,
            inputFileSelect: document.getElementById('inputFileSelect').value,
            auxFileSelect: document.getElementById('auxFileSelect').value,
            figureFileSelect: document.getElementById('figureFileSelect').value,
            revisionFileSelect: document.getElementById('revisionFileSelect').value,
            taskInput: document.getElementById('taskInput').value,
            reflectSelect: document.getElementById('reflectSelect').value,
            commitSelect: document.getElementById('commitSelect').value,
            autoExtractFigure: document.getElementById('autoExtractFigure').checked,
            includeTexCount: document.getElementById('includeTexCount').checked,
            multipleFilesSelect: getSelectedFiles(document.getElementById('multipleFilesSelect')),
            multipleAuxFilesSelect: getSelectedFiles(document.getElementById('multipleAuxFilesSelect')),
            multipleFiguresSelect: getSelectedFiles(document.getElementById('multipleFiguresSelect')),
          };
          vscode.setState(state);
        }

        function restoreState() {
          const previousState = vscode.getState();
          if (previousState) {
            document.getElementById('modelSelect').value = previousState.modelSelect || '';
            document.getElementById('taskSelect').value = previousState.taskSelect || '';
            document.getElementById('inputFileSelect').value = previousState.inputFileSelect || '';
            document.getElementById('auxFileSelect').value = previousState.auxFileSelect || '';
            document.getElementById('figureFileSelect').value = previousState.figureFileSelect || '';
            document.getElementById('revisionFileSelect').value = previousState.revisionFileSelect || '';
            document.getElementById('taskInput').value = previousState.taskInput || '';
            document.getElementById('reflectSelect').value = previousState.reflectSelect || 'default';
            document.getElementById('commitSelect').value = previousState.commitSelect || 'HEAD';
            document.getElementById('autoExtractFigure').checked = previousState.autoExtractFigure || false;
            document.getElementById('includeTexCount').checked = previousState.includeTexCount || false;

            // Restore selected multiple files
            const multipleFilesSelectDiv = document.getElementById('multipleFilesSelect');
            multipleFilesSelectDiv.innerHTML = '';
            if (previousState.multipleFilesSelect && previousState.multipleFilesSelect.length > 0) {
              previousState.multipleFilesSelect.forEach(file => {
                addFileToList('multipleFilesSelect', file);
              });
              multipleFilesSelectDiv.style.display = 'block';
            } else {
              multipleFilesSelectDiv.style.display = 'none';
            }
        
            // Restore selected multiple auxiliary files
            const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
            multipleAuxFilesSelectDiv.innerHTML = '';
            if (previousState.multipleAuxFilesSelect && previousState.multipleAuxFilesSelect.length > 0) {
              previousState.multipleAuxFilesSelect.forEach(file => {
                addFileToList('multipleAuxFilesSelect', file);
              });
              multipleAuxFilesSelectDiv.style.display = 'block';
            } else {
              multipleAuxFilesSelectDiv.style.display = 'none';
            }
        
            // Restore selected multiple figures
            const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
            multipleFiguresSelectDiv.innerHTML = '';
            if (previousState.multipleFiguresSelect && previousState.multipleFiguresSelect.length > 0) {
              previousState.multipleFiguresSelect.forEach(file => {
                addFileToList('multipleFiguresSelect', file);
              });
              multipleFiguresSelectDiv.style.display = 'block';
            } else {
              multipleFiguresSelectDiv.style.display = 'none';
            }
          }
        }

        window.addEventListener('message', event => {
          const message = event.data;
          switch (message.command) {
            case 'setMultipleFiles':
              const multipleFilesSelectDiv = document.getElementById('multipleFilesSelect');
              const existingFiles = getSelectedFiles(multipleFilesSelectDiv);
              const newFiles = message.files.filter(file => !existingFiles.includes(file));
              if (newFiles.length > 0) {
                newFiles.forEach(file => {
                  addFileToList('multipleFilesSelect', file);
                });
                multipleFilesSelectDiv.style.display = 'block';
              }
              saveState();
              break;
            case 'setMultipleAuxFiles':
              const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
              const existingAuxFiles = getSelectedFiles(multipleAuxFilesSelectDiv);
              const newAuxFiles = message.files.filter(file => !existingAuxFiles.includes(file));
              if (newAuxFiles.length > 0) {
                newAuxFiles.forEach(file => {
                  addFileToList('multipleAuxFilesSelect', file);
                });
                multipleAuxFilesSelectDiv.style.display = 'block';
              }
              saveState();
              break;
            case 'setMultipleFigures':
              const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
              const existingFigures = getSelectedFiles(multipleFiguresSelectDiv);
              const newFigures = message.files.filter(file => !existingFigures.includes(file));
              if (newFigures.length > 0) {
                newFigures.forEach(file => {
                  addFileToList('multipleFiguresSelect', file);
                });
                multipleFiguresSelectDiv.style.display = 'block';
              }
              saveState();
              break;
            case 'setInputFile':
              const inputFileSelect = document.getElementById('inputFileSelect');
              inputFileSelect.innerHTML = '';
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                inputFileSelect.appendChild(option);
              });
              break;
            case 'setAuxFile':
              const auxFileSelect = document.getElementById('auxFileSelect');
              auxFileSelect.innerHTML = '';
              const emptyOption = document.createElement('option');
              emptyOption.value = '';
              emptyOption.textContent = 'None';
              auxFileSelect.appendChild(emptyOption);
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                auxFileSelect.appendChild(option);
              });
              break;
            case 'setFigureFile':
              const figureFileSelect = document.getElementById('figureFileSelect');
              figureFileSelect.innerHTML = '';
              const emptyFigureOption = document.createElement('option');
              emptyFigureOption.value = '';
              emptyFigureOption.textContent = 'None';
              figureFileSelect.appendChild(emptyFigureOption);
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                figureFileSelect.appendChild(option);
              });
              break;
            case 'setRevisionFiles':
              const revisionFileSelect = document.getElementById('revisionFileSelect');
              revisionFileSelect.innerHTML = '';
              const noneOption = document.createElement('option');
              noneOption.value = '';
              noneOption.textContent = 'None';
              revisionFileSelect.appendChild(noneOption);
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                revisionFileSelect.appendChild(option);
              });
              break;
            case 'inputFileSelected':
              document.getElementById('inputFileSelect').value = message.filePath;
              vscode.postMessage({
                command: 'requestRevisionFile',
                inputFilePath: message.filePath
              });
              break;
            case 'auxFileSelected':
              document.getElementById('auxFileSelect').value = message.filePath;
              break;
            case 'figureFileSelected':
              document.getElementById('figureFileSelect').value = message.filePath;
              // Clear multiple figures selection when a single figure file is selected
              document.getElementById('multipleFiguresSelect').innerHTML = '';
              document.getElementById('multipleFiguresSelect').style.display = 'none';
              break;
            case 'revisionFileSelected':
              document.getElementById('revisionFileSelect').value = message.filePath;
              break;
            case 'modelSelected':
              document.getElementById('modelSelect').value = message.model;
              break;
            case 'setRecentCommits':
              const commitSelect = document.getElementById('commitSelect');
              commitSelect.innerHTML = '';
              message.commits.forEach(commit => {
                const option = document.createElement('option');
                const [commitHash, ...commitMessage] = commit.split(': ');
                option.value = commitHash;
                option.textContent = commit;
                commitSelect.appendChild(option);
              });
              break;
          }
          // Restore previous state
          restoreState();
        });
      </script>
    </head>
    <body>
      <p>
        <label for="taskSelect">Task:</label>
        <select id="taskSelect">
          <option value="correct-tex">Correct TeX</option>
          <option value="polish-tex">Polish TeX</option>
          <option value="draw-tex">Draw TeX</option>
          <!-- <option value="correct-tex-long">Correct TeX (Long)</option> -->
          <!-- <option value="polish-tex-long">Polish TeX (Long)</option> -->
          <!-- <option value="draw-tex-long">Draw TeX (Long)</option> -->
          <option value="correct-st">Correct ST</option>
          <option value="polish-st">Polish ST</option>
          <option value="draw-st">Draw ST</option>
          <!-- <option value="correct-st-long">Correct ST (Long)</option> -->
          <!-- <option value="polish-st-long">Polish ST (Long)</option> -->
          <!-- <option value="draw-st-long">Draw ST (Long)</option> -->
          <option value="correct-qi">Correct QI</option>
          <option value="polish-qi">Polish QI</option>
          <option value="meeting2text">Meeting to Text</option>
          <option value="paper2note">Paper to Note</option>
          <option value="txt2tex">Txt to TeX</option>
        </select>
      </p>
      <p>
        <label for="inputFileSelect">Select Input File:</label>
        <button id="selectMultipleFilesButton" style="float: right;">Select Multiple</button>
        <button id="emptyMultipleFilesButton" style="float: right; margin-right: 10px;">Empty</button><br>
        <select id="inputFileSelect">
          <option value="">None</option>
        </select>
        <div id="multipleFilesSelect" style="display: none;"></div>
      </p>
      <p>
        <label for="auxFileSelect">Select Auxiliary File:</label>
        <button id="selectMultipleAuxFilesButton" style="float: right;">Select Multiple</button>
        <button id="emptyMultipleAuxFilesButton" style="float: right; margin-right: 10px;">Empty</button><br>
        <select id="auxFileSelect">
          <option value="">None</option>
        </select>
        <div id="multipleAuxFilesSelect" style="display: none;"></div>
      </p>
      <p>
        <label for="figureFileSelect">Select Figure File:</label>
        <button id="selectMultipleFiguresButton" style="float: right;">Select Multiple</button>
        <button id="emptyMultipleFiguresButton" style="float: right; margin-right: 10px;">Empty</button>
        <br>
        <select id="figureFileSelect">
          <option value="">None</option>
        </select>
        <div id="multipleFiguresSelect" style="display: none;"></div>
      </p>
      <p>
        <label for="taskInputArea">Specific Instructions:</label>
        <textarea id="taskInput" style="width: 100%; height: 200px;" placeholder=''></textarea>
      </p>
      <p>
        <label for="reflectSelect">Reflect:</label>
        <select id="reflectSelect">
          <option value="default">Default</option>
          <option value="True">True</option>
          <option value="False">False</option>
        </select>
        <label for="modelSelect">Model:</label>
        <select id="modelSelect">
          <option value="sonnet+">Sonnet+</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
          <option value="gpt4o">GPT-4 Omni</option>
          <option value="gpt4t">GPT-4 Turbo</option>
        </select><br>
        <label for="autoExtractFigure">
          Auto-extract Figs: <input type="checkbox" id="autoExtractFigure">
        </label>
        <label for="includeTexCount">
          Include Tex Count: <input type="checkbox" id="includeTexCount">
        </label>
        <button id="executeButton" style="float: right;">Execute</button>
      </p>
      <p>
        <h5>Housekeeping</h5>
        <label>For the Selected File:</label><br>
        <button id="packSingleButton">Pack Single</button>
        <button id="cleanSingleButton">Clean Single</button>
      </p>
      <p>
        <label>For All the Files:</label><br>
        <button id="indentTexButton">Indent TeX</button>
        <button id="cleanOutputButton">Clean Output</button>
        <button id="cleanBuildButton">Clean Build</button>
      </p>
      <p>
        <h5>LaTeXDiff</h5>
        <label for="revisionFileSelect">Select Revision File for LaTeX Diff:</label>
        <button id="latexDiffButton" style="float: right;">latexdiff</button>
        <select id="revisionFileSelect"></select>
      </p>
      <p>
        <label for="commitSelect">Select Commit:</label>
        <button id="latexDiffVCButton" style="float: right;">latexdiff-vc</button>
        <button id="packLatexDiffVCButton" style="float: right; margin-right: 10px;">Pack</button>
        <button id="refreshCommitsButton" style="float: right; margin-right: 10px;">Refresh</button>
        <select id="commitSelect">
          <option value="HEAD">HEAD</option>
        </select>
      </p>
    </body>
    </html>`;
  }
}
