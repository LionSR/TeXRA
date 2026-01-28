/**
 * Shared VS Code editor utilities.
 *
 * Provides common helpers for opening and manipulating files in VS Code editors.
 */

import * as vscode from 'vscode';

import { WorkspaceFS } from '@utils/files';

/**
 * Open a file in VS Code editor, optionally positioning cursor at a line.
 * Reuses existing editor if file is already open.
 */
export async function openFileInEditor(
  filePath: string,
  line?: number,
  column?: number,
): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const existingEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === uri.fsPath,
    );

    let editor: vscode.TextEditor;
    if (existingEditor) {
      editor = await vscode.window.showTextDocument(existingEditor.document, {
        viewColumn: existingEditor.viewColumn,
        preserveFocus: false,
      });
    } else {
      const document = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
      });
    }

    if (line !== undefined) {
      const position = new vscode.Position(
        Math.max(0, line - 1),
        column ? Math.max(0, column - 1) : 0,
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }

    return uri.fsPath;
  } catch {
    return undefined;
  }
}

/**
 * Ensure a file is open in an editor, optionally saving if dirty.
 * Reuses existing editor if file is already open.
 */
export async function ensureFileOpen(
  filePath: string,
  options: { preserveFocus?: boolean; save?: boolean } = {},
): Promise<{ editor: vscode.TextEditor; absolutePath: string } | undefined> {
  try {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const existingEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === uri.fsPath,
    );
    const preserveFocus = options.preserveFocus ?? !existingEditor;

    let editor: vscode.TextEditor;
    if (existingEditor && preserveFocus) {
      editor = existingEditor;
    } else if (existingEditor) {
      editor = await vscode.window.showTextDocument(existingEditor.document, {
        viewColumn: existingEditor.viewColumn,
        preserveFocus,
      });
    } else {
      const document = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus,
      });
    }

    if (options.save && editor.document.isDirty) {
      await editor.document.save();
    }

    return { editor, absolutePath: uri.fsPath };
  } catch {
    return undefined;
  }
}
