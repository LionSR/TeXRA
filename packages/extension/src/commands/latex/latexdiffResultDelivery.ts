import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  prepareBuildDisplay,
  scheduleViewerDisplay,
} from '@frontend/latex/openBuild';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import type { DiffRunResult } from '@latex/latexdiff/types';
import * as logger from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface OpenedLatexdiffResult {
  diffFilePath: string;
  diffLocation: FileLocation;
  viewerReady: boolean;
}

/**
 * Open and build one generated diff, returning the path, the resolved
 * location, and whether the viewer may be scheduled for it. The path alone is
 * not enough: an external `compileLatex2Pdf` failure can produce a generated
 * file whose PDF is not viewer-ready.
 */
export async function openLatexdiffResult(
  base: FileLocation,
  diffFileName: string,
  options: { scheduleViewer?: boolean } = {},
): Promise<OpenedLatexdiffResult | undefined> {
  const baseDirectory = path.extname(base.absolutePath)
    ? path.dirname(base.absolutePath)
    : base.absolutePath;
  const diffFilePath = path.join(baseDirectory, diffFileName);

  const diffLocation = pathToLocation(diffFilePath);

  if (!(await AbsoluteFS.exists(diffLocation.absolutePath))) {
    await showLoggedMessage(
      CHANNEL,
      `Diff file could not be found. Expected path: ${diffFilePath}`,
    );
    return undefined;
  }

  // Await the file-open/build phase so multi-round latexdiff runs keep their
  // sequential build/show ordering and failures still propagate to the
  // command's error handler. The caller decides whether to schedule a viewer
  // from `viewerReady`; a generated path alone is not enough when external
  // compilation failed (#10553).
  const viewerReady = await prepareBuildDisplay(diffLocation, {
    preserveFocus: true,
    scheduleViewer: options.scheduleViewer,
  });
  return { diffFilePath, diffLocation, viewerReady };
}

/**
 * Restore the last successfully prepared diff as the active LaTeX document
 * before scheduling the argument-free viewer. Used whenever a later processed
 * diff changed LaTeX Workshop's current document/root but is not the intended
 * viewer target (either a later setup rejected, or the last processed diff was
 * not viewer-ready).
 */
async function restorePreparedViewerTarget(
  diffLocation: FileLocation,
): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(diffLocation.absolutePath),
    );
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true,
    });
  } catch (err) {
    // The original setup error still propagates; this is a best-effort viewer
    // target restore, not a second error path.
    logger.warn(
      CHANNEL,
      `Failed to restore the last prepared diff before viewer handoff: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Prepare every successful diff in result order and schedule exactly one
 * detached viewer handoff for the last viewer-ready diff.
 *
 * Each file-open/build phase stays awaited and serialized, so setup errors
 * propagate to the command's single user-facing error handler. The viewer is
 * restored to the last viewer-ready diff whenever a later processed diff is
 * not viewer-ready, including on normal completion (#10553).
 */
export async function prepareLatexdiffResultsAndScheduleViewer(
  results: readonly DiffRunResult[],
): Promise<void> {
  let lastViewerLocation: FileLocation | undefined;
  let lastProcessedLocation: FileLocation | undefined;
  let viewerPrepared = false;
  let completedSetup = false;

  try {
    for (const result of results) {
      const suffix = result.description ? ` (${result.description})` : '';

      if (result.success && result.basePath && result.diffFileName) {
        const opened = await openLatexdiffResult(
          pathToLocation(result.basePath),
          result.diffFileName,
          { scheduleViewer: false },
        );
        if (opened) {
          lastProcessedLocation = opened.diffLocation;
          logger.debug(
            CHANNEL,
            `Successfully generated diff: ${opened.diffFilePath}${suffix}`,
          );
          if (opened.viewerReady) {
            lastViewerLocation = opened.diffLocation;
            viewerPrepared = true;
          }
        }
      } else if (!result.success) {
        logger.warn(
          CHANNEL,
          `Failed to generate diff${suffix}: ${result.message ?? 'Unknown error'}`,
        );
      }
    }
    completedSetup = true;
  } finally {
    if (viewerPrepared && lastViewerLocation) {
      if (
        !completedSetup ||
        !lastProcessedLocation ||
        lastProcessedLocation.absolutePath !== lastViewerLocation.absolutePath
      ) {
        await restorePreparedViewerTarget(lastViewerLocation);
      }
      void scheduleViewerDisplay();
    }
  }
}
