const vscode = acquireVsCodeApi();

document.getElementById('execute').addEventListener('click', () => {
    const task = document.getElementById('task').value;
    const input = document.getElementById('input').value;
    const files = Array.from(document.getElementById('files').files).map(file => file.path);

    vscode.postMessage({
        command: 'executeTask',
        task: task,
        input: input,
        files: files
    });
});