import * as vscode from 'vscode';

export const helpCommands = {
  openDoc: 'texra.openDoc',
};

export function registerHelpCommands(context: vscode.ExtensionContext) {
  const openDocCommand = vscode.commands.registerCommand(
    helpCommands.openDoc,
    async (page: string) => {
      if (!page) {
        return;
      }
      const baseUrl = 'https://texra.ai/guide/';
      const url = `${baseUrl}${page}.html`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  );

  context.subscriptions.push(openDocCommand);

  return { openDocCommand };
}
