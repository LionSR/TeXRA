// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel, pathToLocationIn } from '@texra-ai/harness';
import { pluralize } from '@texra-ai/harness/transcript';
import { runGuardedLatexCommand } from '@frontend/editor/activeFileGuards';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { quickPick } from '@frontend/ui/dialogs';
import { showLoggedInfoMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import { TikzPictureManager } from '@latex/TikzPictureManager';
import type {
  StorageFs,
  WorkspaceFs,
  ProcessServices,
  WorkspaceRoots,
} from '@texra-ai/harness';

const CHANNEL = 'FigCommands';

export function handleCompileTikzFigures(
  roots: WorkspaceRoots,
): Effect.Effect<void, never, ProcessServices | WorkspaceFs | StorageFs> {
  return runGuardedLatexCommand(
    roots,
    {
      channel: CHANNEL,
      action: 'compile TikZ figures',
      errorMessage: 'compileTikzFigures command failed',
    },
    ({ relativePath: filePath }) =>
      Effect.gen(function* () {
        yield* Effect.logDebug(
          `Processing LaTeX file for TikZ compilation: ${filePath}`,
        ).pipe(withLogChannel(CHANNEL));

        // The notification lives for exactly as long as the body below, which
        // is a step of this program rather than a nested settle.
        yield* withVSCodeProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Compiling TikZ Figures',
            cancellable: false,
          },
          (progress) =>
            Effect.gen(function* () {
              progress.report({
                message: 'Extracting and compiling TikZ pictures...',
              });

              // Over the session's rooted filesystems the command root
              // provided, not a view built at this depth.
              const compiledFiles = yield* TikzPictureManager.compile(
                pathToLocationIn(roots.workspace, filePath),
                roots,
              );

              if (compiledFiles.length === 0) {
                yield* showLoggedInfoMessage(
                  CHANNEL,
                  'No TikZ figures found to compile',
                );
                return;
              }

              const items = compiledFiles.map((fileLocation) => ({
                label: path.basename(fileLocation.absolutePath),
                description: path.dirname(fileLocation.absolutePath),
                resourceUri: vscode.Uri.file(fileLocation.absolutePath),
                iconPath: vscode.ThemeIcon.File,
              }));

              const selected = yield* quickPick(items, {
                placeHolder: 'Compiled TikZ figures (select to open)',
                prompt: 'Select a compiled TikZ figure to open in the editor',
                canPickMany: false,
              });

              if (selected) {
                yield* safeExecuteCommand(
                  'vscode.open',
                  [selected.resourceUri],
                  CHANNEL,
                );
              }

              yield* showLoggedInfoMessage(
                CHANNEL,
                `Successfully compiled ${compiledFiles.length} TikZ ${pluralize(compiledFiles.length, 'figure')}`,
              );
            }),
        );
      }),
  );
}
