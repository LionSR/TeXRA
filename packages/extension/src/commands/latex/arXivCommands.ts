// Third-party imports
import * as path from 'node:path';

import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import {
  ArxivProcessor,
  type ArxivDownloadDestination,
} from '@latex/arxivProcessor';
import { resolveLatexFormatter } from '@latex/formatter/texFormatter';
import { createLog } from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';

const CHANNEL = 'arXivCommands';
const log = createLog(CHANNEL);

export async function downloadArXivSource(
  session: SessionHandle,
  runtime: ProcessRuntime,
): Promise<void> {
  const download = Effect.tryPromise({
    catch: (error: unknown) => error,
    try: async () => {
      const arxivId = await vscode.window.showInputBox({
        placeHolder: 'e.g., 2404.12175 or https://arxiv.org/abs/2404.12175',
        prompt: 'Enter arXiv ID or URL',
        validateInput: ArxivProcessor.validateId.bind(ArxivProcessor),
      });

      if (!arxivId) {
        return;
      }

      const paperId = ArxivProcessor.getPaperDirName(arxivId);

      const destinationPick = await vscode.window.showQuickPick(
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
      );

      if (!destinationPick) {
        return;
      }

      const destination = destinationPick.value;

      // Auto-indent is not supported for root destination (would reformat all workspace files)
      const autoIndent =
        destination !== 'root' &&
        (await vscode.window.showQuickPick(['Indent files', 'Skip'], {
          placeHolder: 'Auto-indent LaTeX files after download?',
          canPickMany: false,
        })) === 'Indent files';
      const extractedPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Downloading arXiv Source',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            log.info('User cancelled the download');
          });

          const downloadResult = await runtime.runPromise(
            ArxivProcessor.downloadSource(arxivId, {
              progressCallback: (message, increment) =>
                progress.report({ message, increment }),
              workspaceRoot: session.roots.workspace ?? '',
              formatter: autoIndent
                ? resolveLatexFormatter(session.roots)
                : null,
              autoIndent,
              destination,
            }),
          );
          return downloadResult.path;
        },
      );

      const result = await vscode.window.showInformationMessage(
        `arXiv source downloaded to ${path.basename(extractedPath)}${
          autoIndent ? ' with LaTeX files indented' : ''
        }`,
        'Open Folder',
      );

      if (result === 'Open Folder') {
        void vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(extractedPath),
        );
      }
    },
  });

  await runtime.runPromise(
    download.pipe(
      Effect.catch((error) =>
        showLoggedErrorMessage(
          CHANNEL,
          'Failed to download arXiv source',
          error,
        ).pipe(Effect.asVoid),
      ),
    ),
  );
}
