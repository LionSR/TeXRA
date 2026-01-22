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
 *
 * @param filePath - Path to the file (relative or absolute)
 * @param line - Optional 1-based line number to position cursor
 * @param column - Optional 1-based column number
 * @returns The absolute file path that was opened, or undefined on failure
 */
export async function openFileInEditor(
  filePath: string,
  line?: number,
  column?: number,
): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const absolutePath = uri.fsPath;

    // Check if file is already open in an editor
    const existingEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === absolutePath,
    );

    let editor: vscode.TextEditor;
    if (existingEditor) {
      // Reuse existing editor
      editor = await vscode.window.showTextDocument(existingEditor.document, {
        viewColumn: existingEditor.viewColumn,
        preserveFocus: false,
      });
    } else {
      // Open new editor
      const document = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(document, {
        preserveFocus: false,
        preview: false,
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

    return absolutePath;
  } catch {
    return undefined;
  }
}

/**
 * Ensure a file is open in an editor, optionally saving if dirty.
 * Reuses existing editor if file is already open.
 *
 * @param filePath - Path to the file (relative or absolute)
 * @param options - Options for opening the file
 * @returns The editor and absolute path, or undefined on failure
 */
export async function ensureFileOpen(
  filePath: string,
  options: { preserveFocus?: boolean; save?: boolean } = {},
): Promise<{ editor: vscode.TextEditor; absolutePath: string } | undefined> {
  try {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const absolutePath = uri.fsPath;

    // Check if file is already open
    const existingEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === absolutePath,
    );

    let editor: vscode.TextEditor;
    if (existingEditor) {
      editor = existingEditor;
      if (!options.preserveFocus) {
        editor = await vscode.window.showTextDocument(existingEditor.document, {
          viewColumn: existingEditor.viewColumn,
          preserveFocus: false,
        });
      }
    } else {
      const document = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: options.preserveFocus ?? true,
      });
    }

    if (options.save && editor.document.isDirty) {
      await editor.document.save();
    }

    return { editor, absolutePath };
  } catch {
    return undefined;
  }
}
