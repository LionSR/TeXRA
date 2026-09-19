// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { runGuardedLatexCommand } from '@frontend/editor/activeFileGuards';
import { showLoggedInfoMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import { TikzPictureManager } from '@latex/TikzPictureManager';
import { createLog } from '@logger/logUtils';
import type { ProcessServices } from '@platform/processRuntime';
import { withSessionFs } from '@platform/rootedFs';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { pluralize, truncateWithEllipsis } from '@utils/text/stringUtils';

const CHANNEL = 'FigCommands';
const log = createLog(CHANNEL);

export function handleExtractTikzFigures(
  session: SessionHandle,
): Effect.Effect<void, never, ProcessServices> {
  return runGuardedLatexCommand(
    session,
    {
      channel: CHANNEL,
      action: 'extract TikZ figures',
      errorMessage: 'extractTikzFigures command failed',
    },
    ({ relativePath: filePath }) =>
      Effect.gen(function* () {
        log.debug(`Processing LaTeX file for TikZ figures: ${filePath}`);

        const labeledTikzPictures = yield* TikzPictureManager.extract(
          pathToLocationIn(session.roots.workspace, filePath),
        );

        if (labeledTikzPictures.length === 0) {
          yield* showLoggedInfoMessage(
            CHANNEL,
            'No TikZ figures found in the current file',
          );
          return;
        }

        const items = labeledTikzPictures.map(([label, pictures]) => ({
          label: `${label} (${pictures.length} TikZ ${pluralize(pictures.length, 'picture')})`,
          description: `Figure with label: ${label}`,
          detail: truncateWithEllipsis(pictures[0], 100),
        }));

        const selected = yield* Effect.promise(() =>
          vscode.window.showQuickPick(items, {
            placeHolder: 'Found TikZ figures (select to copy label)',
            prompt: 'Select a TikZ figure label to copy to the clipboard',
            canPickMany: false,
          }),
        );
        if (!selected) return;

        const label = selected.label.split(' (')[0];
        yield* Effect.promise(() => vscode.env.clipboard.writeText(label));
        yield* showLoggedInfoMessage(CHANNEL, `Copied figure label: ${label}`);
      }),
  );
}

export function handleCompileTikzFigures(
  session: SessionHandle,
): Effect.Effect<void, never, ProcessServices> {
  return runGuardedLatexCommand(
    session,
    {
      channel: CHANNEL,
      action: 'compile TikZ figures',
      errorMessage: 'compileTikzFigures command failed',
    },
    ({ relativePath: filePath }) =>
      Effect.gen(function* () {
        log.debug(`Processing LaTeX file for TikZ compilation: ${filePath}`);

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

              const { roots } = session;
              const compiledFiles = yield* withSessionFs(
                roots,
                TikzPictureManager.compile(
                  pathToLocationIn(roots.workspace, filePath),
                  roots,
                ),
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

              const selected = yield* Effect.promise(() =>
                vscode.window.showQuickPick(items, {
                  placeHolder: 'Compiled TikZ figures (select to open)',
                  prompt: 'Select a compiled TikZ figure to open in the editor',
                  canPickMany: false,
                }),
              );

              if (selected) {
                yield* Effect.promise(() =>
                  vscode.commands.executeCommand(
                    'vscode.open',
                    selected.resourceUri,
                  ),
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
