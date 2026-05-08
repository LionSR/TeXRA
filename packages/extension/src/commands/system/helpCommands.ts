// Third-party imports
import * as vscode from 'vscode';

export const helpCommands = {
  openDoc: 'texra.openDoc',
};

export async function openDoc(page: string): Promise<void> {
  if (!page) {
    return;
  }
  const url = `https://texra.ai/guide/${page}.html`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
