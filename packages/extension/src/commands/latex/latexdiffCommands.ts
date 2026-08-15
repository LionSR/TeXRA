// Node imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { createLatexExecutionDiscovery } from '@agent/storage';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { workspaceSM } from '@common/state';
import {
  prepareBuildDisplay,
  scheduleViewerDisplay,
} from '@frontend/latex/openBuild';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedMessageWithDocs,
} from '@frontend/ui/errorHandlingUtils';
import {
  runPackLatexdiffvc,
  type LatexdiffPackResult,
} from '@housekeeping/packLatexdiffvc';
import type { LaTeXdiffResult } from '@latex/latexdiff';
import type {
  DiffRunResult,
  RunLatexdiffCommandConfig,
} from '@latex/latexdiff/types';
import {
  normalizeRunLatexdiffOutputsByRound,
  runLatexdiffForExecution,
} from '@latex/latexdiff/runLatexdiff';
import { CHANNEL, latexdiffService } from '@latex/latexdiff/service';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  describeMathMarkupOption,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import * as logger from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latexConfig';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocation } from '@utils/files/fileLocation';
import { checkToolInstalled } from '@utils/system/toolUtils';

// Local file imports
import {
  getLatexdiffPackNotifications,
  showLatexHousekeepingNotification,
} from './latexHousekeepingNotifications';

type LatexdiffTool = 'latexdiff' | 'latexdiff-vc';

/**
 * Run a latexdiff command body, skipping it when the tool is missing and
 * reporting any failure under `errorMessage`. Every command in this file goes
 * through here.
 */
async function withLatexdiffTool<T>(
  tool: LatexdiffTool,
  errorMessage: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  try {
    if (!(await checkToolInstalled(tool))) {
      logger.warn(CHANNEL, `${tool} is not installed; command will not run.`);
      return undefined;
    }
    return await action();
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, errorMessage, err);
    return undefined;
  }
}

type MarkupItem = vscode.QuickPickItem & { value: MathMarkupOption };

// Returns undefined when the user cancels, logging the cancellation so callers
// only need to bail out.
async function promptForLatexdiffMathMarkup(): Promise<
  MathMarkupOption | undefined
> {
  const configuredMode = workspaceSM.get<string>(
    WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    DEFAULT_MATH_MARKUP,
  );
  const items: MarkupItem[] = MATH_MARKUP_OPTIONS.map((mode) => ({
    label: mode,
    description: describeMathMarkupOption(mode),
    picked: mode === configuredMode,
    value: mode,
  }));
  // Keep the configured mode first so Enter accepts it immediately.
  const prioritizedItems = [
    ...items.filter((item) => item.value === configuredMode),
    ...items.filter((item) => item.value !== configuredMode),
  ];

  const pick = await vscode.window.showQuickPick<MarkupItem>(prioritizedItems, {
    title: 'Latexdiff math markup',
    placeHolder: 'Select math markup granularity for this diff run',
    ignoreFocusOut: true,
    prompt: `Saved default: ${configuredMode} — press Enter to accept, or pick another`,
  });
  if (!pick) {
    logger.debug(CHANNEL, 'Math markup selection cancelled by user');
  }
  return pick?.value;
}

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
async function openLatexdiffResult(
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
): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(diffLocation.absolutePath),
    );
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true,
    });
    return true;
  } catch (err) {
    // The original setup error still propagates; a failed restore is a reason
    // to skip the argument-free viewer rather than open a stale/unrelated PDF.
    logger.warn(
      CHANNEL,
      `Failed to restore the last prepared diff before viewer handoff: ${toErrorMessage(err)}`,
    );
    return false;
  }
}

/**
 * Prepare every successful diff in result order and schedule exactly one
 * detached viewer handoff for the last viewer-ready diff.
 *
 * Each file-open/build phase stays awaited and serialized, so setup errors
 * propagate to `withLatexdiffTool`. The viewer is restored to the last
 * viewer-ready diff whenever a later processed diff is not viewer-ready,
 * including on normal completion (#10553).
 */
async function prepareLatexdiffResultsAndScheduleViewer(
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
      let viewerTargetReady = true;
      if (
        !completedSetup ||
        !lastProcessedLocation ||
        lastProcessedLocation.absolutePath !== lastViewerLocation.absolutePath
      ) {
        viewerTargetReady =
          await restorePreparedViewerTarget(lastViewerLocation);
      }
      if (viewerTargetReady) {
        void scheduleViewerDisplay();
      }
    }
  }
}

/**
 * Prompt for math markup, run a diff, and open the generated diff file. Shared
 * by the `latexdiff` and `latexdiff-vc` entry points, which differ only in the
 * underlying diff call and the tool name used for logging.
 */
async function runDiffAndOpen(
  fileToUseLocation: FileLocation,
  toolLabel: string,
  runDiff: (mathMarkup: MathMarkupOption) => Promise<LaTeXdiffResult>,
): Promise<void> {
  const mathMarkup = await promptForLatexdiffMathMarkup();
  if (!mathMarkup) return;
  logger.info(
    CHANNEL,
    `Running ${toolLabel} with math markup mode: ${mathMarkup}`,
  );

  const result = await runDiff(mathMarkup);
  if (!result.success || !result.diffFileName) {
    throw new Error(result.message ?? 'Failed to generate diff file');
  }
  await openLatexdiffResult(fileToUseLocation, result.diffFileName);
}

// Turn pack/clean run results into user notifications. Folds the notification
// derivation and display that every latexdiff-vc handler invoked together.
function reportLatexdiff(result: LatexdiffPackResult): void {
  const notification = getLatexdiffPackNotifications(result);
  if (notification) {
    void showLatexHousekeepingNotification(CHANNEL, notification);
  }
}

export function registerLatexdiffCommands(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    { id: 'texra.latexdiff', handler: handleLatexdiff },
    { id: 'texra.latexdiffvc', handler: handleLatexdiffvc },
    { id: 'texra.packLatexdiffvc', handler: handlePackLatexdiffvc },
    { id: 'texra.cleanLatexdiffvc', handler: handleCleanLatexdiffvc },
    { id: 'texra.runLatexdiff', handler: handleRunLatexdiff },
  ]);
}

async function handleLatexdiff(
  inputFile: string,
  baseFile: string,
  editedFile: string,
): Promise<void> {
  const fileToUse = baseFile ?? inputFile;
  if (!fileToUse) {
    await showLoggedMessageWithDocs(
      CHANNEL,
      'No base file specified for latexdiff',
      'latex-diff',
      'Latexdiff Docs',
    );
    return;
  }
  if (!editedFile) {
    await showLoggedMessageWithDocs(
      CHANNEL,
      'No revised file specified for latexdiff',
      'latex-diff',
      'Latexdiff Docs',
    );
    return;
  }

  await withLatexdiffTool('latexdiff', 'Error creating LaTeX diff', () => {
    const fileToUseLocation = pathToLocation(fileToUse);
    return runDiffAndOpen(fileToUseLocation, 'latexdiff', (mathMarkup) =>
      latexdiffService.runDiff(
        fileToUseLocation,
        pathToLocation(editedFile),
        '_diff',
        mathMarkup,
      ),
    );
  });
}

async function handleLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
): Promise<void> {
  const fileToUse = baseFile ?? inputFile;
  await withLatexdiffTool('latexdiff-vc', 'Error creating LaTeX diff', () => {
    const fileToUseLocation = pathToLocation(fileToUse);
    return runDiffAndOpen(fileToUseLocation, 'latexdiff-vc', (mathMarkup) =>
      latexdiffService.runDiffVc(fileToUseLocation, commitHash, mathMarkup),
    );
  });
}

async function handlePackLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
  clean: boolean,
): Promise<void> {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error packing LaTeX diff',
    async () => {
      logger.debug(
        CHANNEL,
        `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}, clean=${clean}`,
      );
      const fileToUse = baseFile ?? inputFile;
      reportLatexdiff(await runPackLatexdiffvc(fileToUse, commitHash, clean));
    },
  );
}

async function handleCleanLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
): Promise<void> {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error cleaning LaTeX diff',
    async () => {
      logger.debug(
        CHANNEL,
        `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}`,
      );
      const fileToUse = baseFile ?? inputFile;
      reportLatexdiff(await runPackLatexdiffvc(fileToUse, commitHash, true));
    },
  );
}

async function handleRunLatexdiff(
  config: RunLatexdiffCommandConfig,
): Promise<void> {
  await withLatexdiffTool(
    'latexdiff',
    'Error running LaTeX diffs',
    async () => {
      logger.debug(
        CHANNEL,
        `Command called with config: ${JSON.stringify(config)}`,
      );

      const { agent, model, inputFile } = config;

      if (!agent || !model || !inputFile) {
        await showLoggedMessage(
          CHANNEL,
          'Missing required configuration parameters',
        );
        return;
      }

      const mathMarkup = await promptForLatexdiffMathMarkup();
      if (!mathMarkup) return;

      logger.info(
        CHANNEL,
        `Running latexdiff with math markup mode: ${mathMarkup}`,
      );

      const generateBetweenRoundDiffs = workspaceSM.get<boolean>(
        WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
        LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds,
      );
      logger.debug(
        CHANNEL,
        `Between-round diffs enabled: ${generateBetweenRoundDiffs}`,
      );

      const outputsByRound = normalizeRunLatexdiffOutputsByRound(
        config.outputsByRound,
      );

      const { outcome } = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Running LaTeX diffs',
          cancellable: false,
        },
        (progress) => {
          progress.report({
            increment: 0,
            message: 'Preparing LaTeX diffs...',
          });
          return runLatexdiffForExecution({
            ...config,
            outputsByRound,
            mathMarkup,
            generateBetweenRoundDiffs,
            executionDiscovery: createLatexExecutionDiscovery(),
            latexdiff: { channel: CHANNEL, service: latexdiffService },
            progress,
          });
        },
      );

      const { results } = outcome;

      if (results.length === 0) {
        vscode.window.showInformationMessage(
          'No LaTeX diff operations available for this run.',
        );
        return;
      }

      const successCount = results.filter((r) => r.success).length;

      if (successCount === 0) {
        await showLoggedMessage(
          CHANNEL,
          `All LaTeX diff operations failed (math markup: "${mathMarkup}")`,
        );
      } else if (successCount < results.length) {
        vscode.window.showWarningMessage(
          `${successCount} of ${results.length} LaTeX diff operations completed successfully (math markup: "${mathMarkup}")`,
        );
      } else {
        vscode.window.showInformationMessage(
          `All LaTeX diffs completed successfully (math markup: "${mathMarkup}")`,
        );
      }

      await prepareLatexdiffResultsAndScheduleViewer(results);
    },
  );
}
