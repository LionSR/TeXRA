/**
 * Shared VS Code editor utilities.
 *
 * Provides common helpers for opening and manipulating files in VS Code editors.
 */

import { Data, Effect } from 'effect';
import * as vscode from 'vscode';

import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Why an editor call produced no editor: VS Code would not read the document
 * at all, it read it and would not show it, or it would not write the file
 * back. The three are separate answers because only the first says anything
 * about the file itself, and only the last leaves content unsaved.
 */
export class EditorOpenFailed extends Data.TaggedError('EditorOpenFailed')<{
  readonly reason:
    'document-open-failed' | 'editor-unavailable' | 'save-failed';
  readonly message: string;
  readonly absolutePath: string;
  readonly cause: unknown;
}> {}

/**
 * Clamp a 1-based line number to a 0-based VS Code line index. Floors first
 * so a fractional line number degrades gracefully instead of producing a
 * fractional index; a no-op for the integer line numbers every caller passes.
 */
function toZeroBasedLine(line: number): number {
  return Math.max(0, Math.floor(line) - 1);
}

/**
 * Build a VS Code range spanning 1-based `startLine` through `endLine`
 * (inclusive, defaults to `startLine`). MAX_SAFE_INTEGER is clamped to the
 * line length by VS Code, so this spans the full text of the last line.
 */
export function lineToRange(
  startLine: number,
  endLine: number = startLine,
): vscode.Range {
  const start = toZeroBasedLine(startLine);
  const end = Math.max(start, toZeroBasedLine(endLine));
  return new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
}

/** Find the already-visible editor for `uri`, if any. */
function findVisibleEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.fsPath === uri.fsPath,
  );
}

/** Show `document`, reporting VS Code's refusal as `editor-unavailable`. */
function showTextDocument(
  uri: vscode.Uri,
  document: vscode.TextDocument,
  options: vscode.TextDocumentShowOptions,
): Effect.Effect<vscode.TextEditor, EditorOpenFailed> {
  return Effect.tryPromise({
    try: () => vscode.window.showTextDocument(document, options),
    catch: (cause) =>
      new EditorOpenFailed({
        reason: 'editor-unavailable',
        message: `Could not show ${uri.fsPath} in an editor: ${toErrorMessage(cause)}`,
        absolutePath: uri.fsPath,
        cause,
      }),
  });
}

/**
 * Show `existingEditor`'s document if one is already open for `uri`,
 * otherwise open and show `uri` fresh. `openFileInEditor` skips this entirely
 * when `reuseVisible` is set and the editor is already visible, so an
 * already-open, already-focused editor is reused without another
 * `showTextDocument` call.
 */
function showDocument(
  uri: vscode.Uri,
  existingEditor: vscode.TextEditor | undefined,
  preserveFocus: boolean,
): Effect.Effect<vscode.TextEditor, EditorOpenFailed> {
  if (existingEditor) {
    return showTextDocument(uri, existingEditor.document, {
      viewColumn: existingEditor.viewColumn,
      preserveFocus,
    });
  }
  return Effect.gen(function* () {
    const document = yield* Effect.tryPromise({
      try: () => vscode.workspace.openTextDocument(uri),
      catch: (cause) =>
        new EditorOpenFailed({
          reason: 'document-open-failed',
          message: `Could not open ${uri.fsPath}: ${toErrorMessage(cause)}`,
          absolutePath: uri.fsPath,
          cause,
        }),
    });
    return yield* showTextDocument(uri, document, {
      preview: false,
      preserveFocus,
    });
  });
}

/**
 * Open a file in a VS Code editor, optionally positioning the cursor at a
 * line, saving a dirty document, and (with `reuseVisible`) reusing an
 * already-visible editor without re-showing it.
 *
 * A refusal is the typed `EditorOpenFailed`, so every caller decides for
 * itself what an unopenable file means instead of reading back an absent
 * editor that was warn-logged somewhere else.
 */
export function openFileInEditor(
  absolutePath: string,
  options: {
    line?: number;
    preserveFocus?: boolean;
    save?: boolean;
    /** Reuse an already-visible editor without re-showing it. */
    reuseVisible?: boolean;
  } = {},
): Effect.Effect<
  { editor: vscode.TextEditor; absolutePath: string },
  EditorOpenFailed
> {
  return Effect.gen(function* () {
    const { line, save, reuseVisible } = options;
    const uri = vscode.Uri.file(absolutePath);
    const existingEditor = findVisibleEditor(uri);
    const preserveFocus = options.preserveFocus ?? false;

    const editor =
      reuseVisible && existingEditor && preserveFocus
        ? existingEditor
        : yield* showDocument(uri, existingEditor, preserveFocus);

    if (line !== undefined) {
      yield* Effect.try({
        try: () => {
          const position = new vscode.Position(toZeroBasedLine(line), 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
          );
        },
        catch: (cause) =>
          new EditorOpenFailed({
            reason: 'editor-unavailable',
            message: `Could not move the cursor in ${uri.fsPath}: ${toErrorMessage(cause)}`,
            absolutePath: uri.fsPath,
            cause,
          }),
      });
    }

    if (save && editor.document.isDirty) {
      yield* Effect.tryPromise({
        try: () => editor.document.save(),
        catch: (cause) =>
          new EditorOpenFailed({
            reason: 'save-failed',
            message: `Could not save ${uri.fsPath}: ${toErrorMessage(cause)}`,
            absolutePath: uri.fsPath,
            cause,
          }),
      });
    }

    return { editor, absolutePath: uri.fsPath };
  });
}
