import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const coauthorView = vscode.window.createTreeView('coauthorView', {
        treeDataProvider: new TaskProvider()
    });

    context.subscriptions.push(coauthorView);
}

class TaskProvider implements vscode.TreeDataProvider<TaskItem> {
    getTreeItem(element: TaskItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TaskItem): Thenable<TaskItem[]> {
        if (element) {
            return Promise.resolve([]);
        } else {
            return Promise.resolve([
                new TaskItem("Correct", "Correct Document"),
                new TaskItem("Polish", "Polish Document")
            ]);
        }
    }
}

class TaskItem extends vscode.TreeItem {
    constructor(
        public readonly task: string,
        public readonly tooltip: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(task, collapsibleState);
        this.tooltip = `${this.task} - ${this.tooltip}`;
    }
}
