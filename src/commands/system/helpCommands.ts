// Third-party imports
import * as vscode from 'vscode';

export const helpCommands = {
  openDoc: 'texra.openDoc',
};

export function registerHelpCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      helpCommands.openDoc,
      async (page: string) => {
        if (!page) {
          return;
        }
        const url = `https://texra.ai/guide/${page}.html`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
    ),
  );
}
