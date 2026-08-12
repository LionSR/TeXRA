// Node imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { registerCommands } from '@commands/_shared/registerCommands';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedMessageWithDocs,
} from '@frontend/ui/errorHandlingUtils';
import {
  runPackLatexdiffvc,
  runPackLatexdiffvcMultiple,
  type LatexdiffPackResult,
} from '@housekeeping';
import type { LaTeXdiffResult } from '@latex/latexdiff';
import type { RunLatexdiffCommandConfig } from '@latex/latexdiff/types';
import {
  normalizeRunLatexdiffOutputsByRound,
  runLatexdiffForExecution,
} from '@latex/latexdiff/runLatexdiff';
import { CHANNEL, LaTeXdiffService } from '@latex/latexdiff/service';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  describeMathMarkupOption,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import * as logger from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { AbsoluteFS } from '@utils/files/absoluteFS';
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

async function openLatexdiffResult(
  base: FileLocation,
  diffFileName: string,
): Promise<string | undefined> {
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

  await openBuildDisplayIfTex(diffLocation, { preserveFocus: true });
  return diffFilePath;
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
function reportLatexdiff(
  results: LatexdiffPackResult | LatexdiffPackResult[],
): void {
  for (const notification of getLatexdiffPackNotifications(results)) {
    void showLatexHousekeepingNotification(CHANNEL, notification);
  }
}

export function registerLatexdiffCommands(
  context: vscode.ExtensionContext,
): void {
  registerCommands(context, [
    { id: 'texra.latexdiff', handler: handleLatexdiff },
    { id: 'texra.latexdiffvc', handler: handleLatexdiffvc },
    { id: 'texra.packLatexdiffvc', handler: handlePackLatexdiffvc },
    {
      id: 'texra.packLatexdiffvcMultiple',
      handler: handlePackLatexdiffvcMultiple,
    },
    { id: 'texra.cleanLatexdiffvc', handler: handleCleanLatexdiffvc },
    {
      id: 'texra.cleanLatexdiffvcMultiple',
      handler: handleCleanLatexdiffvcMultiple,
    },
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
      LaTeXdiffService.runDiff(
        fileToUseLocation,
        pathToLocation(editedFile),
        '_diff',
        false,
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
      LaTeXdiffService.runDiffVc(fileToUseLocation, commitHash, mathMarkup),
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

async function handlePackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean,
): Promise<void> {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error packing LaTeX diffs',
    async () => {
      logger.debug(
        CHANNEL,
        `Command called with: commitHash=${commitHash}, clean=${clean}`,
      );
      logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
      reportLatexdiff(
        await runPackLatexdiffvcMultiple(inputFiles, commitHash, clean),
      );
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

async function handleCleanLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
): Promise<void> {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error cleaning LaTeX diffs',
    async () => {
      logger.debug(CHANNEL, `Command called with: commitHash=${commitHash}`);
      logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
      reportLatexdiff(
        await runPackLatexdiffvcMultiple(inputFiles, commitHash, true),
      );
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

      const { agent, model, inputFile, outputFiles } = config;

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
            agent,
            model,
            inputFile,
            outputFiles,
            runId: config.runId,
            outputsByRound,
            mathMarkup,
            generateBetweenRoundDiffs,
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

      for (const result of results) {
        const suffix = result.description ? ` (${result.description})` : '';

        if (result.success && result.basePath && result.diffFileName) {
          const diffFilePath = await openLatexdiffResult(
            pathToLocation(result.basePath),
            result.diffFileName,
          );
          if (diffFilePath) {
            logger.debug(
              CHANNEL,
              `Successfully generated diff: ${diffFilePath}${suffix}`,
            );
          }
        } else if (!result.success) {
          logger.warn(
            CHANNEL,
            `Failed to generate diff${suffix}: ${result.message ?? 'Unknown error'}`,
          );
        }
      }
    },
  );
}
