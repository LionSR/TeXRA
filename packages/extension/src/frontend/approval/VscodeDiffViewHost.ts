import { promises as fs } from 'node:fs';

import * as vscode from 'vscode';

import {
  type DiffOptions,
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/uiHosts';
import { REVEAL_TIMEOUT_MS } from '@tools/approval/toolEditApproval';

import { raceWithTimeout } from '../vscode/raceWithTimeout';

export class VscodeDiffViewHost implements DiffViewHost {
  async openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    options: DiffOptions = {},
  ): Promise<DiffSession> {
    const session = { original, proposed, title };
    await vscode.commands.executeCommand(
      'vscode.diff',
      this.toUri(original),
      this.toUri(proposed),
      title,
      {
        preserveFocus: options.preserveFocus ?? true,
      } satisfies vscode.TextDocumentShowOptions,
    );
    return session;
  }

  async closeDiff(session: DiffSession): Promise<void> {
    const originalUri = this.toUri(session.original).toString();
    const proposedUri = this.toUri(session.proposed).toString();

    const tabsToClose = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff) {
          // Require an exact pair match so we never close an unrelated diff
          // that merely shares one side, nor a tab whose sides are swapped.
          return (
            input.original.toString() === originalUri &&
            input.modified.toString() === proposedUri
          );
        }
        if (input instanceof vscode.TabInputText) {
          const uri = input.uri.toString();
          return uri === originalUri || uri === proposedUri;
        }
        return false;
      });

    if (tabsToClose.length > 0) {
      await vscode.window.tabGroups.close(tabsToClose);
    }
  }

  async revealFirstChange(session: DiffSession, line: number): Promise<void> {
    const targetUri = this.toUri(session.proposed).toString();
    const position = new vscode.Position(line, 0);

    const tryReveal = () => {
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === targetUri,
      );

      if (!editor) {
        return false;
      }

      editor.selections = [new vscode.Selection(position, position)];
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
      return true;
    };

    if (tryReveal()) {
      return;
    }

    const raced = await raceWithTimeout<void>(
      (resolve) =>
        vscode.window.onDidChangeVisibleTextEditors(() => {
          if (tryReveal()) resolve();
        }),
      REVEAL_TIMEOUT_MS,
    );
    if (raced.timedOut) tryReveal();
  }

  async readProposedContent(session: DiffSession): Promise<string> {
    const proposedUri = this.toUri(session.proposed);
    const openDocument = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === proposedUri.toString(),
    );
    return openDocument
      ? openDocument.getText()
      : await fs.readFile(proposedUri.fsPath, 'utf8');
  }

  private toUri(source: DiffSource): vscode.Uri {
    return vscode.Uri.file(source.filePath);
  }
}
