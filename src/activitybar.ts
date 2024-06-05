import * as vscode from 'vscode';

export class ActivityBarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        console.log('Resolving CoAuthor webview');
        console.log('Webview data:', this.getHtmlForWebview(webviewView.webview));

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'executeTask':
                    this.executeTask(data.task, data.input, data.files);
                    break;
            }
        });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css'));

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>Coauthor for VS Code</title>
            </head>
            <body>
                <h1>Coauthor Activity Bar</h1>
                <div>
                    <label for="task">Task:</label>
                    <select id="task">
                        <option value="correct">Correct</option>
                        <option value="polish">Polish</option>
                        <!-- Add more tasks as needed -->
                    </select>
                </div>
                <div>
                    <label for="input">Input:</label>
                    <input type="text" id="input" />
                </div>
                <div>
                    <label for="files">Select Files:</label>
                    <input type="file" id="files" multiple />
                </div>
                <button id="execute">Execute</button>
                <div id="output"></div>
                <button id="confirm">Next Step</button>
                <script src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }

    private executeTask(task: string, input: string, files: string[]) {
        const { exec } = require('child_process');
        const command = `coauthor ${task} ${files.join(' ')} --input ${input}`;

        exec(command, (err: any, stdout: string, stderr: string) => {
            if (err) {
                this._view?.webview.postMessage({ command: 'showOutput', output: `Error: ${stderr}` });
                return;
            }
            this._view?.webview.postMessage({ command: 'showOutput', output: stdout });
        });
    }
}