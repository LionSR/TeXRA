// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { workspaceRelativePath } from '@texra-ai/harness/node';
import type { WorkspaceRoots } from '@texra-ai/harness';

export function getCurrentFile(
  roots: WorkspaceRoots,
): Effect.Effect<string | null> {
  return Effect.sync(() => {
    const workspaceRoot = roots.workspace;
    // Try activeTextEditor first (for text files)
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.uri.scheme === 'file') {
      return workspaceRelativePath(workspaceRoot, doc.uri.fsPath);
    }

    // Fallback to active tab (for media files like images, PDFs)
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const isFileInput =
      (input instanceof vscode.TabInputText ||
        input instanceof vscode.TabInputCustom) &&
      input.uri.scheme === 'file';

    return isFileInput
      ? workspaceRelativePath(workspaceRoot, input.uri.fsPath)
      : null;
  });
}
