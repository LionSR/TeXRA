/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.deactivate = exports.activate = void 0;
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = __importStar(__webpack_require__(1));
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
function activate(context) {
    const terminal = vscode.window.createTerminal();
    context.subscriptions.push(vscode.commands.registerCommand('coauthor.cleanOutput', () => {
        terminal.show();
        terminal.sendText("coauthor clean-output");
    }), vscode.commands.registerCommand('coauthor.cleanBuild', () => {
        terminal.show();
        terminal.sendText("coauthor clean-build");
    }), vscode.commands.registerCommand('coauthor.indentTex', () => {
        terminal.show();
        terminal.sendText("coauthor indent-tex");
    }), vscode.commands.registerCommand('coauthor.execute', (task, filePath, auxFilePath, instructions, reflect, model) => {
        const terminal_new = vscode.window.createTerminal();
        terminal_new.show();
        let command = `coauthor ${task} ${filePath}`;
        if (auxFilePath) {
            command += ` --auxiliary_file=${auxFilePath}`;
        }
        if (instructions) {
            const escapedInstructions = instructions
                .replace(/\\/g, '\\\\') // Escape backslashes
                .replace(/"/g, '\\"') // Escape double quotes
                .replace(/{/g, '\\{') // Escape curly braces
                .replace(/}/g, '\\}'); // Escape curly braces
            command += ` --instruction="${escapedInstructions}"`;
        }
        if (model) {
            command += ` --model=${model}`;
        }
        if (reflect !== 'default') { // Only add --reflect if it's not the default option
            command += ` --reflect=${reflect}`;
        }
        terminal_new.sendText(command);
    }), vscode.commands.registerCommand('coauthor.selectInputFile', async () => {
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
    }), vscode.commands.registerCommand('coauthor.cleanSingle', (filePath) => {
        const terminal_new = vscode.window.createTerminal();
        terminal_new.show();
        terminal_new.sendText(`coauthor clean-single ${filePath}`);
    }), vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context)));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context)));
}
exports.activate = activate;
// This method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;
class CoAuthorViewProvider {
    context;
    constructor(context) {
        this.context = context;
    }
    resolveWebviewView(webviewView) {
        webviewView.webview.options = {
            enableScripts: true
        };
        webviewView.webview.html = this.getWebviewContent();
        webviewView.webview.onDidReceiveMessage(async (message) => {
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
                    const filePath_val = message.filePath;
                    const auxFilePath_val = message.auxFilePath;
                    const instructions_val = message.instructions;
                    const reflect_val = message.reflect;
                    const model_val = message.model;
                    vscode.commands.executeCommand('coauthor.execute', task_val, filePath_val, auxFilePath_val, instructions_val, reflect_val, model_val);
                    break;
                case 'selectInputFile':
                    const filePath = await vscode.commands.executeCommand('coauthor.selectInputFile');
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
            }
        });
    }
    async listAuxFiles() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const workspacePath = workspaceFolders[0].uri.fsPath;
            return await this.getFilesInDirectory(workspacePath, ['.bst', '.bib', '.pdf', '.cls', '.sty', '.py', '.json', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['_log_', 'Makefile', 'template']);
        }
        return [];
    }
    async listFiles() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const workspacePath = workspaceFolders[0].uri.fsPath;
            return await this.getFilesRecursively(workspacePath, workspacePath, ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['build', 'node_modules', 'figures', 'Figs', '__pycache__', 'Figures', 'figs'], ['_log_', 'Makefile', 'template']);
        }
        return [];
    }
    async getFilesInDirectory(dir, excludeExtensions = [], excludeKeywords = []) {
        const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        return dirEntries
            .filter(([name, type]) => type === vscode.FileType.File && !name.startsWith('.') && !excludeExtensions.some(ext => name.endsWith(ext)) && !excludeKeywords.some(keyword => name.includes(keyword)))
            .map(([name]) => name);
    }
    async getFilesRecursively(dir, root, excludeExtensions = [], excludeDirectories = [], excludeKeywords = []) {
        const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        const files = await Promise.all(dirEntries.map(async ([name, type]) => {
            const fullPath = `${dir}/${name}`;
            const relativePath = fullPath.replace(`${root}/`, '');
            if (type === vscode.FileType.Directory && !name.startsWith('.') && !excludeDirectories.includes(name)) {
                return await this.getFilesRecursively(fullPath, root, excludeExtensions, excludeDirectories, excludeKeywords);
            }
            else if (type === vscode.FileType.File && !name.startsWith('.') && !excludeExtensions.some(ext => name.endsWith(ext)) && !excludeKeywords.some(keyword => name.includes(keyword))) {
                return [relativePath];
            }
            else {
                return [];
            }
        }));
        return files.flat();
    }
    getWebviewContent() {
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
          // Restore previous state
          restoreState();
        };        
        // Add event listeners for buttons
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
            const filePath = document.getElementById('inputFileSelect').value;
            const auxFilePath = document.getElementById('auxFileSelect').value;
            const instructions = document.getElementById('taskInput').value;
            const reflect = document.getElementById('reflectSelect').value;
            const model = document.getElementById('modelSelect').value;
            vscode.postMessage({
              command: 'execute',
              task: task,
              filePath: filePath,
              auxFilePath: auxFilePath,
              instructions: instructions,
              reflect: reflect,
              model: model
            });
          });
          document.getElementById('cleanSingleButton').addEventListener('click', function() {
            const filePath = document.getElementById('inputFileSelect').value;
            vscode.postMessage({
              command: 'cleanSingle',
              filePath: filePath
            });
          });

          // Save state on input changes
          document.getElementById('modelSelect').addEventListener('change', saveState);
          document.getElementById('taskSelect').addEventListener('change', saveState);
          document.getElementById('inputFileSelect').addEventListener('change', saveState);
          document.getElementById('auxFileSelect').addEventListener('change', saveState);
          document.getElementById('taskInput').addEventListener('input', saveState);
          document.getElementById('reflectSelect').addEventListener('change', saveState);
        });

        function saveState() {
          const state = {
            modelSelect: document.getElementById('modelSelect').value,
            taskSelect: document.getElementById('taskSelect').value,
            inputFileSelect: document.getElementById('inputFileSelect').value,
            auxFileSelect: document.getElementById('auxFileSelect').value,
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
            document.getElementById('taskInput').value = previousState.taskInput || '';
            document.getElementById('reflectSelect').value = previousState.reflectSelect || 'default';
          }
        }

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
      <label for="modelSelect">Model:</label>
      <select id="modelSelect">
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
        <option value="gpt4o">GPT-4 Omni</option>
        <option value="gpt4t">GPT-4 Turbo</option>
      </select>
      </p>
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
      </p>
      <button id="executeButton">Execute</button>
      <p>
      <label>Housekeepings for all files:</label>
      <button id="indentTexButton">Indent TeX</button>
      <button id="cleanOutputButton">Clean Output</button>
      <button id="cleanBuildButton">Clean Build</button>
      </p>
      <p>
      <label>Housekeepings for selected file:</label>
      <button id="cleanSingleButton">Clean Single</button>
      </p>
    </body>
    </html>`;
    }
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map