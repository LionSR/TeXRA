// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context))
  );
}

class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getWebviewContent();
  }

  private getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CoAuthor Panel</title>
    </head>
    <body>
      <h1>CoAuthor LaTeX Editor</h1>
      <select id="taskSelect">
        <option value="correct">Correct</option>
        <option value="polish">Polish</option>
      </select>
      <input type="text" id="taskInput" placeholder="Enter your LaTeX code">
      <button>Submit</button>
      <p id="output">Output will be displayed here.</p>
    </body>
    </html>`;
  }
}

// This method is called when your extension is deactivated
export function deactivate() { }
