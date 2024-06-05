// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.clean', () => {
      const terminal = vscode.window.createTerminal();
      terminal.show();
      terminal.sendText("coauthor clean");
    }),
    vscode.commands.registerCommand('coauthor.cleanBuild', () => {
      const terminal = vscode.window.createTerminal();
      terminal.show();
      terminal.sendText("coauthor clean-build");
    }),
    vscode.commands.registerCommand('coauthor.indentTex', () => {
      const terminal = vscode.window.createTerminal();
      terminal.show();
      terminal.sendText("coauthor indent-tex");
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

    webviewView.webview.onDidReceiveMessage(message => {
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
      }
    });
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
        });
      </script>
    </head>
    <body>
      <h2>CoAuthor</h2>
      <p id="taskSelect">
      <label for="taskSelect">Tasks:</label>
      <select id="taskSelect">
        <option value="correct">Correct</option>
        <option value="polish">Polish</option>
      </select>
      </p>
      <p id="taskInputArea">
      <label for="taskInputArea">Custom Instructions:</label>
      <textarea id="taskInput" style="width: 100%; height: 200px;" placeholder='focus on the filling in the missing derivations; improve the coherence of the paragraphs. etc'></textarea>
      </p>
      <button id="executeButton">Execute</button>
      <p id="housekeepings">Housekeepings:</p>
      <button id="indentTexButton">Indent TeX</button>
      <button id="cleanButton">Clean</button>
      <button id="cleanBuildButton">Clean Build</button>
      </p>
    </body>
    </html>`;
  }
}
