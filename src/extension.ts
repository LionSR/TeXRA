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
    vscode.commands.registerCommand('coauthor.execute', (task: string, filePath: string, auxFilePath: string, instructions: string, reflect: boolean) => {
      terminal.show();
      if (auxFilePath) {
        terminal.sendText(`coauthor ${task} ${filePath} --auxiliary_file=${auxFilePath} --instruction="${instructions}"`);
      } else {
        terminal.sendText(`coauthor ${task} ${filePath} --instruction="${instructions}"`);
      }
    }),
    vscode.commands.registerCommand('coauthor.selectInputFile', async () => {
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
          const filePath_val = message.filePath;
          const auxFilePath_val = message.auxFilePath;
          const instructions_val = message.instructions;
          const reflect_val = message.reflect;
          vscode.commands.executeCommand('coauthor.execute', task_val, filePath_val, auxFilePath_val, instructions_val, reflect_val);
          break;
        case 'selectInputFile':
          const filePath = await vscode.commands.executeCommand<string>('coauthor.selectInputFile');
          if (filePath) {
            webviewView.webview.postMessage({ command: 'inputFileSelected', filePath });
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
        case 'inputFileSelected':
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
      return await this.getFilesInDirectory(workspacePath, ['.bst', '.bib', '.pdf', ".cls", ".sty", "*.py", "*.json", "*.ipynb"]);
    }
    return [];
  }

  private async listFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesRecursively(workspacePath, workspacePath, ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', "*.py", "*.ipynb"], ['build', 'node_modules', 'figures', 'Figs', "__pycache__"]);
    }
    return [];
  }

  private async getFilesInDirectory(dir: string, excludeExtensions: string[] = []): Promise<string[]> {
    const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return dirEntries
      .filter(([name, type]) => type === vscode.FileType.File && !name.startsWith('.') && !excludeExtensions.some(ext => name.endsWith(ext)) && name.includes('.'))
      .map(([name]) => name);
  }

  private async getFilesRecursively(dir: string, root: string, excludeExtensions: string[] = [], excludeDirectories: string[] = []): Promise<string[]> {
    const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    const files = await Promise.all(dirEntries.map(async ([name, type]) => {
      const fullPath = `${dir}/${name}`;
      const relativePath = fullPath.replace(`${root}/`, '');
      if (type === vscode.FileType.Directory && !name.startsWith('.') && !excludeDirectories.includes(name)) {
        return await this.getFilesRecursively(fullPath, root, excludeExtensions, excludeDirectories);
      } else if (type === vscode.FileType.File && !name.startsWith('.') && !excludeExtensions.some(ext => name.endsWith(ext)) && name.includes('.')) {
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
            const filePath = document.getElementById('inputFileSelect').value;
            const auxFilePath = document.getElementById('auxFileSelect').value;
            const instructions = document.getElementById('taskInput').value;
            const reflect = document.getElementById('reflectSelect').value === 'true';
            vscode.postMessage({
              command: 'execute',
              task: task,
              filePath: filePath,
              auxFilePath: auxFilePath,
              instructions: instructions,
              reflect: reflect
            });
          });
        });

        window.addEventListener('message', event => {
          const message = event.data;
          switch (message.command) {
            case 'setFiles':
              const inputFileSelect = document.getElementById('inputFileSelect');
              inputFileSelect.innerHTML = '';
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                inputFileSelect.appendChild(option);
              });
              break;
            case 'inputFileSelected':
              document.getElementById('inputFileSelect').value = message.filePath;
              break;
            case 'setAuxFiles':
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
      <label for="modelSelect">Models:</label>
      <select id="modelSelect">
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
        <option value="gpt4o">GPT-4 Omni</option>
        <option value="gpt4t">GPT-4 Turbo</option>
      </select>
      </p>
      <p>
      <label for="taskSelect">Tasks:</label>
      <select id="taskSelect">
        <option value="correct-tex">Correct TeX</option>
        <option value="polish-tex">Polish TeX</option>
        <option value="correct-qi">Correct QI</option>
        <option value="correct-st">Correct ST</option>
        <option value="meeting2text">Meeting to Text</option>
        <option value="paper2note">Paper to Note</option>
        <option value="txt2tex">Paper to Note</option>
      </select>
      </p>
      <p>
      <label for="inputFileSelect">Select Input File:</label><br>
      <select id="inputFileSelect"></select>
      </p>
      <p>
      <label for="auxFileSelect">Select Auxiliary File:</label><br>
      <select id="auxFileSelect"></select>
      </p>
      <p>
      <label for="taskInputArea">Specific Instructions:</label>
      <textarea id="taskInput" style="width: 100%; height: 200px;" placeholder=''></textarea>
      </p>
      <p>
      <label for="reflectSelect">Reflect:</label>
      <select id="reflectSelect">
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
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