// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const terminal = vscode.window.createTerminal();
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.packSingle', (inputFilePath: string, task: string, reflect: string, model: string) => {
      const terminal_new = vscode.window.createTerminal();
      terminal_new.show();
      terminal_new.sendText(`coauthor pack-single ${inputFilePath} --task=${task} --reflect=${reflect} --model=${model}`);
    }),
    vscode.commands.registerCommand('coauthor.cleanOutput', () => {
      terminal.show();
      terminal.sendText("coauthor clean-output");
    }),
    vscode.commands.registerCommand('coauthor.cleanBuild', () => {
      terminal.show();
      terminal.sendText("coauthor clean-build");
    }),
    vscode.commands.registerCommand('coauthor.indentTex', () => {
      terminal.show();
      terminal.sendText("coauthor indent-tex");
    }),
    vscode.commands.registerCommand('coauthor.execute', (task: string, inputFilePath: string, auxFilePath: string, instructions: string, reflect: string, model: string, figureFilePath: string) => {
      const terminal_new = vscode.window.createTerminal();
      terminal_new.show();

      let command = `coauthor ${task} ${inputFilePath}`;
      if (auxFilePath) {
        command += ` --auxiliary_file=${auxFilePath}`;
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
      if (figureFilePath) {
        command += ` --figure_input="${figureFilePath}"`;
      }

      terminal_new.sendText(command);
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
    vscode.commands.registerCommand('coauthor.cleanSingle', (filePath: string) => {
      const terminal_new = vscode.window.createTerminal();
      terminal_new.show();
      terminal_new.sendText(`coauthor clean-single ${filePath}`);
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
          const auxFilePath_val = message.auxFilePath;
          const instructions_val = message.instructions;
          const reflect_val = message.reflect;
          const model_val = message.model;
          const figureFilePath_val = message.figureFilePath;
          vscode.commands.executeCommand('coauthor.execute', task_val, inputFilePath_val, auxFilePath_val, instructions_val, reflect_val, model_val, figureFilePath_val);
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
        case 'requestInputFiles':
          const files = await this.listInputFiles();
          webviewView.webview.postMessage({ command: 'setInputFiles', files: files });
          break;
        case 'requestAuxFiles':
          const auxFiles = await this.listAuxFiles();
          webviewView.webview.postMessage({ command: 'setAuxFiles', files: auxFiles });
          break;
        case 'requestFigureFiles':
          const figureFiles = await this.listFigureFiles();
          webviewView.webview.postMessage({ command: 'setFigureFiles', files: figureFiles });
          break;
        case 'inputFileSelected':
          vscode.window.showInformationMessage(`Selected file: ${message.filePath}`);
          break;
        case 'auxFileSelected':
          vscode.window.showInformationMessage(`Selected auxiliary file: ${message.filePath}`);
          break;
        case 'figureFileSelected':
          vscode.window.showInformationMessage(`Selected figure file: ${message.filePath}`);
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
          vscode.commands.executeCommand('coauthor.cleanSingle', message.filePath);
          break;
        case 'packSingle':
          vscode.commands.executeCommand('coauthor.packSingle', message.inputFilePath, message.task, message.reflect, message.model);
          break;
      }
    });
  }

  private async listInputFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['build', 'node_modules', 'figures', 'Figs', '__pycache__', 'Figures', 'figs'], ['_log_', 'Makefile', 'template', '_log']);
    }
    return [];
  }

  private async listAuxFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesInDirectory(workspacePath, ['.txt', '.tex', '.cls'], ['.bst', '.bib', '.pdf', '.cls', '.sty', '.py', '.json', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['_log_', 'Makefile', 'template', '_log']);
    }
    return [];
  }

  private async listFigureFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      return await this.getFilesRecursively(workspacePath, workspacePath, ['.png', '.pdf', '.jpeg'], ['.txt', '.tex', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.vslx', '.ts', '.js'], ['build', 'node_modules', '__pycache__'], ['_log_', 'Makefile', 'template']);
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
      if (type === vscode.FileType.Directory && !name.startsWith('.') && !excludeDirectories.includes(name)) {
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
      <script>
        const vscode = acquireVsCodeApi();
        window.onload = function() {
          vscode.postMessage({ command: 'requestInputFiles' });
          vscode.postMessage({ command: 'requestAuxFiles' });
          vscode.postMessage({ command: 'requestFigureFiles' });
          // Restore previous state
          restoreState();
        };        
        document.addEventListener('DOMContentLoaded', function() {
          document.getElementById('modelSelect').addEventListener('change', function() {
            vscode.postMessage({
              command: 'modelSelect',
              model: this.value
            });
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
            vscode.postMessage({
              command: 'execute',
              task: task,
              inputFilePath: inputFilePath,
              auxFilePath: auxFilePath,
              instructions: instructions,
              reflect: reflect,
              model: model,
              figureFilePath: figureFilePath
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
            vscode.postMessage({
              command: 'cleanSingle',
              filePath: inputFilePath
            });
          });

          // Save state on input changes
          document.getElementById('modelSelect').addEventListener('change', saveState);
          document.getElementById('taskSelect').addEventListener('change', saveState);
          document.getElementById('inputFileSelect').addEventListener('change', saveState);
          document.getElementById('auxFileSelect').addEventListener('change', saveState);
          document.getElementById('figureFileSelect').addEventListener('change', saveState);
          document.getElementById('taskInput').addEventListener('input', saveState);
          document.getElementById('reflectSelect').addEventListener('change', saveState);
        });

        function saveState() {
          const state = {
            modelSelect: document.getElementById('modelSelect').value,
            taskSelect: document.getElementById('taskSelect').value,
            inputFileSelect: document.getElementById('inputFileSelect').value,
            auxFileSelect: document.getElementById('auxFileSelect').value,
            figureFileSelect: document.getElementById('figureFileSelect').value,
            taskInput: document.getElementById('taskInput').value,
            reflectSelect: document.getElementById('reflectSelect').value
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
            document.getElementById('taskInput').value = previousState.taskInput || '';
            document.getElementById('reflectSelect').value = previousState.reflectSelect || 'default';
          }
        }

        window.addEventListener('message', event => {
          const message = event.data;
          switch (message.command) {
            case 'setInputFiles':
              const inputFileSelect = document.getElementById('inputFileSelect');
              inputFileSelect.innerHTML = '';
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                inputFileSelect.appendChild(option);
              });
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
            case 'setFigureFiles':
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
            case 'inputFileSelected':
              document.getElementById('inputFileSelect').value = message.filePath;
              break;
            case 'auxFileSelected':
              document.getElementById('auxFileSelect').value = message.filePath;
              break;
            case 'figureFileSelected':
              document.getElementById('figureFileSelect').value = message.filePath;
              break;
            case 'modelSelected':
              document.getElementById('modelSelect').value = message.model;
              break;
          }
          // Restore previous state
          restoreState();
        });
      </script>
    </head>
    <body>
      <h2>CoAuthor</h2>
      <p>
      <label for="taskSelect">Task:</label>
      <select id="taskSelect">
        <option value="correct-tex">Correct TeX</option>
        <option value="polish-tex">Polish TeX</option>
        <option value="correct-qi">Correct QI</option>
        <option value="correct-st">Correct ST</option>
        <option value="polish-st">Polish ST</option>
        <option value="meeting2text">Meeting to Text</option>
        <option value="paper2note">Paper to Note</option>
        <option value="txt2tex">Txt to TeX</option>
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
      <label for="figureFileSelect">Select Figure File:</label><br>
      <select id="figureFileSelect"></select>
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
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
        <option value="gpt4o">GPT-4 Omni</option>
        <option value="gpt4t">GPT-4 Turbo</option>
      </select>
      <button id="executeButton">Execute</button>
      </p>
      <p>
      <label>Housekeepings for the selected file:</label><br>
      <button id="packSingleButton">Pack Single</button>
      <button id="cleanSingleButton">Clean Single</button>
      </p>
      <p>
      <label>Housekeepings for all the files:</label><br>
      <button id="indentTexButton">Indent TeX</button>
      <button id="cleanOutputButton">Clean Output</button>
      <button id="cleanBuildButton">Clean Build</button>
      </p>

    </body>
    </html>`;
  }
}