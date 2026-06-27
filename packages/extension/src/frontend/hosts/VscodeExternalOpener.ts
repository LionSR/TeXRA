// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { ExternalOpener } from '@hosts/uiHosts';

export class VscodeExternalOpener implements ExternalOpener {
  async openExternal(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async openPath(filePath: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.file(filePath));
  }
}
