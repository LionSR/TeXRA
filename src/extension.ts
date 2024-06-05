// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const terminal = vscode.window.createTerminal();
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.clean', () => {
      terminal.show();
      terminal.sendText("coauthor clean");
    }),
    vscode.commands.registerCommand('coauthor.cleanBuild', () => {
      terminal.show();
      terminal.sendText("coauthor clean-build");
    }),
    vscode.commands.registerCommand('coauthor.indentTex', () => {
      terminal.show();
      terminal.sendText("coauthor indent-tex");
    }),
    vscode.commands.registerCommand('coauthor.execute', (task: string, instructions: string, filePath: string) => {
      terminal.show();
      terminal.sendText(`coauthor ${task} ${filePath}`);
    }),
    vscode.commands.registerCommand('coauthor.selectFile', async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select File',
        canSelectFiles: true,
        canSelectFolders: false
      });
      if (fileUri && fileUri[0]) {
        vscode.window.showInformationMessage(`Selected file: ${fileUri[0].fsPath}`);
        return fileUri[0].fsPath;
      }
      return null;
    }),
    vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context))
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
        case 'clean':
          vscode.commands.executeCommand('coauthor.clean');
          break;
        case 'cleanBuild':
          vscode.commands.executeCommand('coauthor.cleanBuild');
          break;
        case 'indentTex':
          vscode.commands.executeCommand('coauthor.indentTex');
          break;
        case 'execute':
          const task_val = message.task;
          const instructions_val = message.instructions;
          const filePath_val = message.filePath;
          vscode.commands.executeCommand('coauthor.execute', task_val, instructions_val, filePath_val);
          break;
        case 'selectFile':
          const filePath = await vscode.commands.executeCommand<string>('coauthor.selectFile');
          if (filePath) {
            webviewView.webview.postMessage({ command: 'fileSelected', filePath });
          }
          break;
        case 'requestFiles':
          const files = await this.listFiles();
          webviewView.webview.postMessage({ command: 'setFiles', files });
          break;
        case 'requestAuxFiles':
          const auxFiles = await this.listAuxFiles();
          webviewView.webview.postMessage({ command: 'setAuxFiles', files: auxFiles });
          break;
        case 'fileSelected':
          vscode.window.showInformationMessage(`Selected file: ${message.filePath}`);
          break;
        case 'auxFileSelected':
          vscode.window.showInformationMessage(`Selected auxiliary file: ${message.filePath}`);
          break;
      }
    });
  }
  
  
  private async listAuxFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesInDirectory(workspacePath);
    }
    return [];
  }

  private async listFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesRecursively(workspacePath, workspacePath);
    }
    return [];
  }

  private async getFilesInDirectory(dir: string): Promise<string[]> {
    const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return dirEntries
      .filter(([name, type]) => type === vscode.FileType.File && !name.startsWith('.'))
      .map(([name]) => name);
  }

  private async getFilesRecursively(dir: string, root: string): Promise<string[]> {
    const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    const files = await Promise.all(dirEntries.map(async ([name, type]) => {
      const fullPath = `${dir}/${name}`;
      const relativePath = fullPath.replace(`${root}/`, '');
      if (type === vscode.FileType.Directory && !name.startsWith('.') && name !== 'build' && name !== 'node_modules') {
        return await this.getFilesRecursively(fullPath, root);
      } else if (type === vscode.FileType.File && !name.startsWith('.') && !name.endsWith('.bst') && !name.endsWith('.bib') && !name.endsWith('.cls')) {
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
      <script>
        const vscode = acquireVsCodeApi();
        window.onload = function() {
          vscode.postMessage({ command: 'requestFiles' });
          vscode.postMessage({ command: 'requestAuxFiles' });
        };
        document.addEventListener('DOMContentLoaded', function() {
          document.getElementById('cleanButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'clean'
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
            const instructions = document.getElementById('taskInput').value;
            const filePath = document.getElementById('fileSelect').value;
            const auxFilePath = document.getElementById('auxFileSelect').value;
            vscode.postMessage({
              command: 'execute',
              task: task,
              instructions: instructions,
              filePath: filePath
            });
          });
        });

        window.addEventListener('message', event => {
          const message = event.data;
          switch (message.command) {
            case 'setFiles':
              const fileSelect = document.getElementById('fileSelect');
              fileSelect.innerHTML = '';
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                fileSelect.appendChild(option);
              });
              break;
            case 'fileSelected':
              document.getElementById('fileSelect').value = message.filePath;
              break;
            case 'setAuxFiles':
              const auxFileSelect = document.getElementById('auxFileSelect');
              auxFileSelect.innerHTML = '';
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                auxFileSelect.appendChild(option);
              });
              break;
            case 'auxFileSelected':
              document.getElementById('auxFileSelect').value = message.filePath;
              break;
          }
        });
      </script>
    </head>
    <body>
      <h2>CoAuthor</h2>
      <p>
      <label for="taskSelect">Tasks:</label>
      <select id="taskSelect">
        <option value="correct-tex">Correct TeX</option>
        <option value="polish">Polish</option>
        <option value="correct-qi">Correct QI</option>
        <option value="correct-st">Correct ST</option>
        <option value="meeting2text">Meeting to Text</option>
        <option value="paper2note">Paper to Note</option>
        <option value="txt2tex">Paper to Note</option>
      </select>
      </p>
      <p>
      <label for="fileSelect">Select Input File:</label><br>
      <select id="fileSelect"></select>
      </p>
      <p>
      <label for="auxFileSelect">Select Auxiliary File:</label><br>
      <select id="auxFileSelect"></select>
      </p>
      <p>
      <label for="taskInputArea">Custom Instructions:</label>
      <textarea id="taskInput" style="width: 100%; height: 200px;" placeholder='focus on the filling in the missing derivations; improve the coherence of the paragraphs. etc, etc.'></textarea>
      </p>
      <button id="executeButton">Execute</button>
      <p>
      <label>Housekeepings:</label>
      <button id="indentTexButton">Indent TeX</button>
      <button id="cleanButton">Clean</button>
      <button id="cleanBuildButton">Clean Build</button>
      </p>
    </body>
    </html>`;
  }
}