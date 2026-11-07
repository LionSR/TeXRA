// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel, WorkspaceFs } from '@texra-ai/harness/host';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';

const CHANNEL = 'openFileCommands';

/**
 * Open `absolutePath` in the preview editor and put the cursor where `at`
 * says, for a line request and a label match alike.
 */
function openInEditor(
  absolutePath: string,
  at: (doc: vscode.TextDocument) => vscode.Position,
) {
  return openFileInEditor(absolutePath, { preview: true }).pipe(
    Effect.map(({ editor }) => {
      const pos = at(editor.document);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter,
      );
      editor.selection = new vscode.Selection(pos, pos);
    }),
  );
}

export function openFile(file: string, line?: number) {
  // An absolute path opens as is; a relative one names a workspace file.
  const opened = Effect.gen(function* () {
    const absolutePath = path.isAbsolute(file)
      ? file
      : yield* (yield* WorkspaceFs).resolve(file);
    return yield* line !== undefined && line > 0
      ? openInEditor(absolutePath, () => new vscode.Position(line - 1, 0))
      : executeVscodeCommand('vscode.open', vscode.Uri.file(absolutePath));
  });
  return opened.pipe(
    Effect.tapError((error) =>
      Effect.logError(`Could not open ${file}: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
    Effect.asVoid,
  );
}
