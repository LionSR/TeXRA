// Third-party imports
import * as path from 'node:path';

import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  ArxivProcessor,
  type ArxivDownloadDestination,
} from '@latex/arxivProcessor';
import { resolveLatexFormatter } from '@latex/formatter/texFormatter';
import { createLog } from '@logger/logUtils';
import type { ProcessServices } from '@platform/processRuntime';

const CHANNEL = 'arXivCommands';
const log = createLog(CHANNEL);

/**
 * Prompt for an arXiv ID and a destination, then download under a progress
 * notification that lives for exactly as long as the download.
 *
 * The prompts are the foreign edge; the download is a step of this program.
 * `catchCause` is the command's one terminal boundary, as the `catch` it
 * replaces was: a typed failure and a rejected prompt alike are squashed to
 * the value that `catch` clause bound, so the message is unchanged.
 */
export function downloadArXivSource(
  session: SessionHandle,
): Effect.Effect<void, never, ProcessServices> {
  return Effect.gen(function* () {
    const arxivId = yield* Effect.promise(() =>
      vscode.window.showInputBox({
        placeHolder: 'e.g., 2404.12175 or https://arxiv.org/abs/2404.12175',
        prompt: 'Enter arXiv ID or URL',
        validateInput: ArxivProcessor.validateId.bind(ArxivProcessor),
      }),
    );

    if (!arxivId) {
      return;
    }

    const paperId = ArxivProcessor.getPaperDirName(arxivId);

    const destinationPick = yield* Effect.promise(() =>
      vscode.window.showQuickPick(
        [
          {
            label: `References/${paperId}`,
            description: 'Download into References folder',
            value: 'references' as ArxivDownloadDestination,
          },
          {
            label: 'Workspace root',
            description: 'Download directly into the workspace root',
            value: 'root' as ArxivDownloadDestination,
          },
        ],
        {
          placeHolder: 'Where should the source be downloaded?',
          canPickMany: false,
        },
      ),
    );

    if (!destinationPick) {
      return;
    }

    const destination = destinationPick.value;

    // Auto-indent is not supported for root destination (would reformat all workspace files)
    const autoIndent =
      destination !== 'root' &&
      (yield* Effect.promise(() =>
        vscode.window.showQuickPick(['Indent files', 'Skip'], {
          placeHolder: 'Auto-indent LaTeX files after download?',
          canPickMany: false,
        }),
      )) === 'Indent files';

    const extractedPath = yield* withVSCodeProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading arXiv Source',
        cancellable: true,
      },
      (progress, token) =>
        Effect.gen(function* () {
          token.onCancellationRequested(() => {
            log.info('User cancelled the download');
          });

          const downloadResult = yield* ArxivProcessor.downloadSource(arxivId, {
            progressCallback: (message, increment) =>
              progress.report({ message, increment }),
            workspaceRoot: session.roots.workspace ?? '',
            formatter: autoIndent ? resolveLatexFormatter(session.roots) : null,
            autoIndent,
            destination,
          });
          return downloadResult.path;
        }),
    );

    const result = yield* Effect.promise(() =>
      vscode.window.showInformationMessage(
        `arXiv source downloaded to ${path.basename(extractedPath)}${
          autoIndent ? ' with LaTeX files indented' : ''
        }`,
        'Open Folder',
      ),
    );

    if (result === 'Open Folder') {
      void vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(extractedPath),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      showLoggedErrorMessage(
        CHANNEL,
        'Failed to download arXiv source',
        Cause.squash(cause),
      ).pipe(Effect.asVoid),
    ),
  );
}
