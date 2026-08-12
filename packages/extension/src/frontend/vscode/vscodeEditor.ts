/**
 * Shared VS Code editor utilities.
 *
 * Provides common helpers for opening and manipulating files in VS Code editors.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'vscodeEditor';

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

/**
 * Show `existingEditor`'s document if one is already open for `uri`,
 * otherwise open and show `uri` fresh. `openFileInEditor` skips this entirely
 * when `reuseVisible` is set and the editor is already visible, so an
 * already-open, already-focused editor is reused without another
 * `showTextDocument` call.
 */
async function showDocument(
  uri: vscode.Uri,
  existingEditor: vscode.TextEditor | undefined,
  preserveFocus: boolean,
): Promise<vscode.TextEditor> {
  if (existingEditor) {
    return vscode.window.showTextDocument(existingEditor.document, {
      viewColumn: existingEditor.viewColumn,
      preserveFocus,
    });
  }
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus,
  });
}

/**
 * Open a file in a VS Code editor, optionally positioning the cursor at a
 * line, saving a dirty document, and (with `reuseVisible`) reusing an
 * already-visible editor without re-showing it.
 */
export async function openFileInEditor(
  filePath: string,
  options: {
    line?: number;
    column?: number;
    preserveFocus?: boolean;
    save?: boolean;
    /** Reuse an already-visible editor without re-showing it. */
    reuseVisible?: boolean;
  } = {},
): Promise<{ editor: vscode.TextEditor; absolutePath: string } | undefined> {
  try {
    const { line, column, save, reuseVisible } = options;
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const existingEditor = findVisibleEditor(uri);
    const preserveFocus = options.preserveFocus ?? false;

    const editor =
      reuseVisible && existingEditor && preserveFocus
        ? existingEditor
        : await showDocument(uri, existingEditor, preserveFocus);

    if (line !== undefined) {
      const position = new vscode.Position(
        toZeroBasedLine(line),
        column ? Math.max(0, column - 1) : 0,
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }

    if (save && editor.document.isDirty) {
      await editor.document.save();
    }

    return { editor, absolutePath: uri.fsPath };
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to open ${filePath} in an editor: ${toErrorMessage(err)}`,
    );
    return undefined;
  }
}
