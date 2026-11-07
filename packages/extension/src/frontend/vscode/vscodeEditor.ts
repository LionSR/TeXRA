/**
 * Shared VS Code editor utilities.
 *
 * Provides common helpers for opening and manipulating files in VS Code editors.
 */

import { Effect, Schema } from 'effect';
import * as vscode from 'vscode';

import { toErrorMessage } from '@texra-ai/harness/schemas';

/** VS Code would not read the document, or would not show it; the message
 *  says which. */
class EditorOpenFailed extends Schema.TaggedError<EditorOpenFailed>()(
  'EditorOpenFailed',
  {
    message: Schema.String,
    absolutePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

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

/** Show `document`, reporting VS Code's refusal. */
function showTextDocument(
  uri: vscode.Uri,
  document: vscode.TextDocument,
  options: vscode.TextDocumentShowOptions,
): Effect.Effect<vscode.TextEditor, EditorOpenFailed> {
  return Effect.tryPromise({
    try: () => vscode.window.showTextDocument(document, options),
    catch: (cause) =>
      new EditorOpenFailed({
        message: `Could not show ${uri.fsPath} in an editor: ${toErrorMessage(cause)}`,
        absolutePath: uri.fsPath,
        cause,
      }),
  });
}

/**
 * Show `existingEditor`'s document in its own column if one is already open
 * for `uri`, otherwise open and show `uri` fresh.
 */
function showDocument(
  uri: vscode.Uri,
  existingEditor: vscode.TextEditor | undefined,
  preserveFocus: boolean,
  preview: boolean,
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
          message: `Could not open ${uri.fsPath}: ${toErrorMessage(cause)}`,
          absolutePath: uri.fsPath,
          cause,
        }),
    });
    return yield* showTextDocument(uri, document, {
      preview,
      preserveFocus,
    });
  });
}

/**
 * Open a file in a VS Code editor, optionally positioning the cursor at a
 * line.
 *
 * A refusal is the typed `EditorOpenFailed`, so every caller decides for
 * itself what an unopenable file means instead of reading back an absent
 * editor that was warn-logged somewhere else.
 */
export const openFileInEditor = Effect.fn('openFileInEditor')(function* (
  absolutePath: string,
  options: {
    line?: number;
    preserveFocus?: boolean;
    /** Open a fresh document in the preview tab, not a permanent one. */
    preview?: boolean;
  } = {},
): Effect.fn.Return<
  { editor: vscode.TextEditor; absolutePath: string },
  EditorOpenFailed
> {
  const { line } = options;
  const uri = vscode.Uri.file(absolutePath);
  const editor = yield* showDocument(
    uri,
    findVisibleEditor(uri),
    options.preserveFocus ?? false,
    options.preview ?? false,
  );

  if (line !== undefined) {
    const position = new vscode.Position(toZeroBasedLine(line), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  return { editor, absolutePath: uri.fsPath };
});
