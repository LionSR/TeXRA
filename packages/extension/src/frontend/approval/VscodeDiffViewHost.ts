import { Effect, FileSystem, Option } from 'effect';
import * as vscode from 'vscode';

import {
  fromHost,
  hostFailure,
  type HostCallFailed,
} from '@controllers/session/hostCallFailure';
import { type DiffSource, type DiffViewHost } from '@hosts/uiHosts';
import type { RequestRefusal } from '@shared/session/requestErrors';
import { REVEAL_TIMEOUT_MS } from '@tools/approval/toolEditApproval';

import { firstEventOrTimeout } from '../vscode/vscodeEventWait';

/**
 * The failure of a `vscode.*` call this host lifted through `fromHost`: the
 * host's own refusal, tagged with the capability that raised it.
 */
type EditorCallFailed = HostCallFailed | RequestRefusal;

/**
 * The file URI a tab input surfaces, or null when the tab shows no single
 * file. `closeDiff` uses it to find the tabs showing a diff session's files.
 */
function tabInputFileUri(tab: vscode.Tab): vscode.Uri | null {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  return null;
}

/**
 * The two sides and the title one open diff was shown under. Only this host
 * reads one back: closing a diff, revealing its first change and reading its
 * proposed side are all written against VS Code's tab model.
 */
export interface DiffSession {
  original: DiffSource;
  proposed: DiffSource;
  title: string;
}

export class VscodeDiffViewHost implements DiffViewHost {
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Effect.Effect<void, EditorCallFailed> {
    return fromHost('vscode.diff', () =>
      vscode.commands.executeCommand(
        'vscode.diff',
        this.toUri(original),
        this.toUri(proposed),
        title,
        { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
      ),
    ).pipe(Effect.asVoid);
  }

  closeDiff(session: DiffSession): Effect.Effect<void, EditorCallFailed> {
    return Effect.suspend(() => {
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
          const uriString = tabInputFileUri(tab)?.toString();
          return uriString === originalUri || uriString === proposedUri;
        });

      if (tabsToClose.length === 0) return Effect.void;
      return fromHost('tabGroups.close', () =>
        vscode.window.tabGroups.close(tabsToClose),
      ).pipe(Effect.asVoid);
    });
  }

  revealFirstChange(session: DiffSession, line: number): Effect.Effect<void> {
    return Effect.suspend(() => {
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
        return Effect.void;
      }

      // The proposed side may not be visible yet: wait for the visibility
      // change that lets the reveal land, and try once more if the wait times
      // out — the same last attempt the raced promise made.
      return firstEventOrTimeout<void>(
        (report) =>
          vscode.window.onDidChangeVisibleTextEditors(() => {
            if (tryReveal()) report(undefined);
          }),
        REVEAL_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap((revealed) =>
          Option.isNone(revealed)
            ? Effect.sync(() => {
                tryReveal();
              })
            : Effect.void,
        ),
      );
    });
  }

  readProposedContent(
    session: DiffSession,
  ): Effect.Effect<string, EditorCallFailed, FileSystem.FileSystem> {
    return Effect.suspend(() => {
      const proposedUri = this.toUri(session.proposed);
      const openDocument = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === proposedUri.toString(),
      );
      return openDocument
        ? Effect.succeed(openDocument.getText())
        : FileSystem.FileSystem.use((fs) =>
            fs.readFileString(proposedUri.fsPath),
          ).pipe(
            Effect.mapError((cause) =>
              hostFailure('readProposedContent', cause),
            ),
          );
    });
  }

  private toUri(source: DiffSource): vscode.Uri {
    return vscode.Uri.file(source.filePath);
  }
}
