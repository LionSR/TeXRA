// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { ClipboardHost } from '@hosts/clipboardHost';

export class VscodeClipboardHost implements ClipboardHost {
  async readText(): Promise<string> {
    return vscode.env.clipboard.readText();
  }

  async writeText(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }
}
