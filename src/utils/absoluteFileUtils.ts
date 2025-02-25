// Third-party imports
import * as vscode from 'vscode';

export async function fileExistsAbsolute(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}
