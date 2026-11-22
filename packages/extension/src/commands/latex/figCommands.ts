// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { runGuardedLatexCommand } from '@frontend/editor/activeFileGuards';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { quickPick } from '@frontend/ui/dialogs';
import { showLoggedInfoMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import { compileTikzPictures, extractTikzPictures } from '@latex/tikzPictures';
import type { WorkspaceRoots } from '@texra-ai/worldline';
import type { ProcessServices } from '@texra-ai/worldline/host';
import {
  type StorageFs,
  type WorkspaceFs,
  withLogChannel,
  pathToLocationIn,
} from '@texra-ai/worldline/plugins';
import { pluralize } from '@texra-ai/worldline/schemas';

const CHANNEL = 'FigCommands';

export function handleCompileTikzFigures(
  roots: WorkspaceRoots,
): Effect.Effect<void, never, ProcessServices | WorkspaceFs | StorageFs> {
  return runGuardedLatexCommand(
    roots,
    {
      action: 'compile TikZ figures',
      errorMessage: 'Could not compile TikZ figures',
    },
    Effect.fnUntraced(function* ({ relativePath: filePath }) {
      yield* Effect.logDebug(
        `Processing LaTeX file for TikZ compilation: ${filePath}`,
      );

      // The notification lives for exactly as long as the body below, which
      // is a step of this program rather than a nested run.
      yield* withVSCodeProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Compiling TikZ figures…',
          cancellable: false,
        },
        Effect.fnUntraced(function* (progress) {
          progress.report({
            message: 'Extracting and compiling TikZ figures…',
          });

          // Over the session's rooted filesystems the command root
          // provided, not a view built at this depth.
          const latexFile = pathToLocationIn(roots.workspace, filePath);
          const compiledFiles = yield* compileTikzPictures(
            latexFile,
            yield* extractTikzPictures(latexFile),
            roots,
          );

          if (compiledFiles.length === 0) {
            yield* showLoggedInfoMessage('No TikZ figures found to compile.');
            return;
          }

          const items = compiledFiles.map((fileLocation) => ({
            label: path.basename(fileLocation.absolutePath),
            description: path.dirname(fileLocation.absolutePath),
            resourceUri: vscode.Uri.file(fileLocation.absolutePath),
            iconPath: vscode.ThemeIcon.File,
          }));

          const selected = yield* quickPick(items, {
            placeHolder: 'Select a compiled TikZ figure to open',
            canPickMany: false,
          });

          if (selected) {
            yield* safeExecuteCommand('vscode.open', [selected.resourceUri]);
          }

          yield* showLoggedInfoMessage(
            `Compiled ${compiledFiles.length} TikZ ${pluralize(compiledFiles.length, 'figure')}.`,
          );
        }),
      );
    }),
  ).pipe(withLogChannel(CHANNEL));
}
