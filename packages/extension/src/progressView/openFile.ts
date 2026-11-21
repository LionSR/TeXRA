// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness/plugins';
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

export function openFile(absolutePath: string, line?: number) {
  const opened: Effect.Effect<unknown, Error> =
    line !== undefined && line > 0
      ? openInEditor(absolutePath, () => new vscode.Position(line - 1, 0))
      : executeVscodeCommand('vscode.open', vscode.Uri.file(absolutePath));
  return opened.pipe(
    Effect.tapError((error) =>
      Effect.logError(`Could not open ${absolutePath}: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
    Effect.asVoid,
  );
}
