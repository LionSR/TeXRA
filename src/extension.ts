import * as vscode from 'vscode';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('coauthor.executeTask', () => {
        const panel = vscode.window.createWebviewPanel(
            'coauthorOutput',
            'CoAuthor Output',
            vscode.ViewColumn.One,
            {}
        );

        const task = getSelectedTask(); // Implement this function based on your UI logic
        const input = getUserInput(); // Implement this function to get user input
        const filePath = getFilePath(); // Implement this function to get file path

        exec(`python your_script.py ${task} ${input} ${filePath}`, (err, stdout, stderr) => {
            if (err) {
                panel.webview.html = `Error: ${stderr}`;
                return;
            }
            panel.webview.html = `Output: ${stdout}`;
        });
    });

    context.subscriptions.push(disposable);
}

function getSelectedTask(): string {
    // Logic to get the selected task
    return "Correct";
}

function getUserInput(): string {
    // Logic to get user input
    return "Specific request";
}

function getFilePath(): string {
    // Logic to get file path
    return "/path/to/document.tex";
}

export function deactivate() {}