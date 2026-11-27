import { Effect, FileSystem, Option } from 'effect';
import * as vscode from 'vscode';

import {
  fromHost,
  hostFailure,
} from '@texra/controllers/session/hostCallFailure';
import type { HostFailed } from '@texra/hosts/uiHosts';

import { firstEventOrTimeout } from '../vscode/vscodeEvents';
import { type RequestRefusal } from '@texra/controllers/session/hostCallFailure';

/** How long a reveal waits for the diff's proposed side to become visible. */
const REVEAL_TIMEOUT_MS = 1500;

/**
 * The failure of a `vscode.*` call this host lifted through `fromHost`: the
 * host's own refusal, tagged with the capability that raised it.
 */
type EditorCallFailed = HostFailed | RequestRefusal;

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
 * VS Code's diff surface, addressed by the two staged paths a diff shows.
 * Closing a diff, revealing its first change and reading back its proposed
 * side are written against VS Code's tab model.
 */
export class VscodeDiffViewHost {
  openDiff(
    originalPath: string,
    proposedPath: string,
    title: string,
  ): Effect.Effect<void, EditorCallFailed> {
    return fromHost('vscode.diff', () =>
      vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(originalPath),
        vscode.Uri.file(proposedPath),
        title,
        { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
      ),
    ).pipe(Effect.asVoid);
  }

  closeDiff(
    originalPath: string,
    proposedPath: string,
  ): Effect.Effect<void, EditorCallFailed> {
    return Effect.suspend(() => {
      const originalUri = vscode.Uri.file(originalPath).toString();
      const proposedUri = vscode.Uri.file(proposedPath).toString();

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

  revealFirstChange(proposedPath: string, line: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      const targetUri = vscode.Uri.file(proposedPath).toString();
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
      // out.
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
    proposedPath: string,
  ): Effect.Effect<string, EditorCallFailed, FileSystem.FileSystem> {
    return Effect.suspend(() => {
      const openDocument = this.proposedDocument(proposedPath);
      return openDocument
        ? Effect.succeed(openDocument.getText())
        : FileSystem.FileSystem.use((fs) =>
            fs.readFileString(proposedPath),
          ).pipe(
            Effect.mapError((cause) =>
              hostFailure('readProposedContent', cause),
            ),
          );
    });
  }

  /**
   * Open `text`, the proposed side as the user left it, in an untitled
   * editor of its own, where it outlives the diff. The proposed side's
   * buffer is then saved, so closing the diff does not ask about a file
   * that is about to be removed.
   */
  keepProposedText(
    proposedPath: string,
    text: string,
  ): Effect.Effect<void, EditorCallFailed> {
    const proposedDocument = () => this.proposedDocument(proposedPath);
    return Effect.gen(function* () {
      const proposed = proposedDocument();
      const copy = yield* fromHost('openTextDocument', () =>
        vscode.workspace.openTextDocument({
          content: text,
          language: proposed?.languageId,
        }),
      );
      yield* fromHost('showTextDocument', () =>
        vscode.window.showTextDocument(copy, {
          preview: false,
          preserveFocus: true,
        }),
      );
      if (proposed?.isDirty === true)
        yield* fromHost('saveProposed', () => proposed.save());
    });
  }

  /** The proposed side's open document, if the editor holds one. */
  private proposedDocument(
    proposedPath: string,
  ): vscode.TextDocument | undefined {
    const proposedUri = vscode.Uri.file(proposedPath).toString();
    return vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === proposedUri,
    );
  }
}
