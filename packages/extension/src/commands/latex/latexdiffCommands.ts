// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { registerCommands } from '@commands/_shared/registerCommands';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
  showLoggedMessageWithDocs,
} from '@frontend/ui/errorHandlingUtils';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import {
  runPackLatexdiffvc,
  runPackLatexdiffvcMultiple,
  runCleanLatexdiffvc,
  runCleanLatexdiffvcMultiple,
} from '@housekeeping';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  describeMathMarkupOption,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import { CHANNEL, service } from '@latex/latexdiff/service';
import { runLatexdiffForExecution } from '@latex/latexdiff/runLatexdiff';
import type { RunLatexdiffCommandConfig } from '@latex/latexdiff/types';
import * as logger from '@logger/logUtils';
import { RoundKeySchema } from '@shared/schemas';
import type { FileLocation, OutputFileInfo } from '@shared/schemas';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { flexibleFS, pathToLocation } from '@utils/files';
import { checkToolInstalled } from '@utils/system';

import {
  getLatexdiffPackNotifications,
  type LatexHousekeepingNotification,
} from './latexHousekeepingNotifications';

type LatexdiffTool = 'latexdiff' | 'latexdiff-vc';

async function ensureLatexdiffToolInstalled(
  tool: LatexdiffTool,
): Promise<boolean> {
  const installed = await checkToolInstalled(tool);
  if (!installed) {
    logger.warn(CHANNEL, `${tool} is not installed; command will not run.`);
  }
  return installed;
}

async function withLatexdiffTool<T>(
  tool: LatexdiffTool,
  errorMessage: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  try {
    if (!(await ensureLatexdiffToolInstalled(tool))) {
      return undefined;
    }
    return await action();
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, errorMessage, err);
    return undefined;
  }
}

async function promptForLatexdiffMathMarkup(): Promise<
  MathMarkupOption | undefined
> {
  const configuredMode = workspaceSM.get<string>(
    WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    DEFAULT_MATH_MARKUP,
  );
  const items: (vscode.QuickPickItem & { value: MathMarkupOption })[] =
    MATH_MARKUP_OPTIONS.map((mode) => ({
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

  type MarkupItem = vscode.QuickPickItem & { value: MathMarkupOption };
  return await new Promise<MathMarkupOption | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<MarkupItem>();
    let settled = false;
    const finish = (value: MathMarkupOption | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      qp.dispose();
    };
    qp.title = 'Latexdiff math markup';
    qp.placeholder = 'Select math markup granularity for this diff run';
    qp.ignoreFocusOut = true;
    qp.items = prioritizedItems;
    const defaultItem = prioritizedItems.at(0);
    if (defaultItem) {
      qp.activeItems = [defaultItem];
    }
    // VS Code 1.108+: show the saved default as a persistent hint below the
    // input box so users know why one item is listed first. Older hosts
    // (incl. Cursor 1.105) silently ignore the property.
    if ('prompt' in qp) {
      (qp as MarkupQuickPick).prompt =
        `Saved default: ${configuredMode} — press Enter to accept, or pick another`;
    }
    qp.onDidAccept(() => {
      const picked = qp.activeItems[0] ?? qp.selectedItems[0];
      finish(picked?.value);
    });
    qp.onDidHide(() => {
      finish(undefined);
    });
    qp.show();
  });
}

type MarkupQuickPick = vscode.QuickPick<
  vscode.QuickPickItem & { value: MathMarkupOption }
> & { prompt: string };

async function openLatexdiffResult(
  base: FileLocation,
  diffFileName: string,
): Promise<string | undefined> {
  const baseDirectory = path.extname(base.absolutePath)
    ? path.dirname(base.absolutePath)
    : base.absolutePath;
  const diffFilePath = path.join(baseDirectory, diffFileName);

  const diffLocation = pathToLocation(diffFilePath);

  if (!(await flexibleFS.exists(diffLocation))) {
    await showLoggedMessage(
      CHANNEL,
      `Diff file could not be found. Expected path: ${diffFilePath}`,
    );
    return undefined;
  }

  await openBuildDisplayIfTex(diffLocation, { preserveFocus: true });
  return diffFilePath;
}

function showLatexdiffPackNotifications(
  notifications: LatexHousekeepingNotification[],
): void {
  for (const notification of notifications) {
    if (notification.severity === 'info') {
      void showLoggedInfoMessage(CHANNEL, notification.message);
    } else if (notification.severity === 'error') {
      void showLoggedErrorMessage(
        CHANNEL,
        notification.message,
        notification.error,
      );
    } else {
      void showLoggedMessage(CHANNEL, notification.message);
    }
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

  await withLatexdiffTool(
    'latexdiff',
    'Error creating LaTeX diff',
    async () => {
      const mathMarkup = await promptForLatexdiffMathMarkup();
      if (!mathMarkup) {
        logger.debug(CHANNEL, 'Math markup selection cancelled by user');
        return;
      }
      logger.info(
        CHANNEL,
        `Running latexdiff with math markup mode: ${mathMarkup}`,
      );

      const fileToUseLocation = pathToLocation(fileToUse);
      const result = await service.runDiff(
        fileToUseLocation,
        pathToLocation(editedFile),
        '_diff',
        false,
        mathMarkup,
      );

      if (!result.success || !result.diffFileName) {
        throw new Error(result.message ?? 'Failed to generate diff file');
      }

      await openLatexdiffResult(fileToUseLocation, result.diffFileName);
    },
  );
}

async function handleLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
): Promise<void> {
  const fileToUse = baseFile ?? inputFile;
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error creating LaTeX diff',
    async () => {
      const mathMarkup = await promptForLatexdiffMathMarkup();
      if (!mathMarkup) {
        logger.debug(CHANNEL, 'Math markup selection cancelled by user');
        return;
      }
      logger.info(
        CHANNEL,
        `Running latexdiff-vc with math markup mode: ${mathMarkup}`,
      );

      const fileToUseLocation = pathToLocation(fileToUse);
      const result = await service.runDiffVc(
        fileToUseLocation,
        commitHash,
        mathMarkup,
      );

      if (!result.success || !result.diffFileName) {
        throw new Error(result.message ?? 'Failed to generate diff file');
      }

      await openLatexdiffResult(fileToUseLocation, result.diffFileName);
    },
  );
}

async function handlePackLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
  clean: boolean,
) {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error packing LaTeX diff',
    async () => {
      logger.debug(
        CHANNEL,
        `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}, clean=${clean}`,
      );
      const fileToUse = baseFile ?? inputFile;
      showLatexdiffPackNotifications(
        getLatexdiffPackNotifications(
          await runPackLatexdiffvc(fileToUse, commitHash, clean),
        ),
      );
    },
  );
}

async function handlePackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean,
) {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error packing LaTeX diffs',
    async () => {
      logger.debug(
        CHANNEL,
        `Command called with: commitHash=${commitHash}, clean=${clean}`,
      );
      logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
      showLatexdiffPackNotifications(
        getLatexdiffPackNotifications(
          await runPackLatexdiffvcMultiple(inputFiles, commitHash, clean),
        ),
      );
    },
  );
}

async function handleCleanLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error cleaning LaTeX diff',
    async () => {
      logger.debug(
        CHANNEL,
        `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}`,
      );
      const fileToUse = baseFile ?? inputFile;
      showLatexdiffPackNotifications(
        getLatexdiffPackNotifications(
          await runCleanLatexdiffvc(fileToUse, commitHash),
        ),
      );
    },
  );
}

async function handleCleanLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
) {
  await withLatexdiffTool(
    'latexdiff-vc',
    'Error cleaning LaTeX diffs',
    async () => {
      logger.debug(CHANNEL, `Command called with: commitHash=${commitHash}`);
      logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
      showLatexdiffPackNotifications(
        getLatexdiffPackNotifications(
          await runCleanLatexdiffvcMultiple(inputFiles, commitHash),
        ),
      );
    },
  );
}

async function handleRunLatexdiff(
  config: RunLatexdiffCommandConfig,
): Promise<void> {
  try {
    logger.debug(
      CHANNEL,
      `Command called with config: ${JSON.stringify(config)}`,
    );

    if (!(await ensureLatexdiffToolInstalled('latexdiff'))) {
      return;
    }

    const { agent, model, inputFile, outputFiles } = config;

    if (!agent || !model || !inputFile) {
      await showLoggedMessage(
        CHANNEL,
        'Missing required configuration parameters',
      );
      return;
    }

    const mathMarkup = await promptForLatexdiffMathMarkup();
    if (!mathMarkup) {
      logger.debug(CHANNEL, 'Math markup selection cancelled by user');
      return;
    }

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

    const runId = config.runId ?? undefined;

    let outputsByRound: Map<number, OutputFileInfo[]> | null = null;
    if (config.outputsByRound) {
      const roundMap = new Map<number, OutputFileInfo[]>();
      for (const [roundKey, value] of Object.entries(config.outputsByRound)) {
        const roundResult = RoundKeySchema.safeParse(roundKey);
        if (roundResult.success && Array.isArray(value) && value.length > 0) {
          roundMap.set(roundResult.data, value);
        }
      }
      if (roundMap.size > 0) {
        outputsByRound = new Map(
          [...roundMap.entries()].sort((a, b) => a[0] - b[0]),
        );
      }
    }

    const { outcome } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running LaTeX diffs',
        cancellable: false,
      },
      (progress) => {
        progress.report({ increment: 0, message: 'Preparing LaTeX diffs...' });
        return runLatexdiffForExecution({
          agent,
          model,
          inputFile,
          outputFiles,
          runId,
          outputsByRound,
          mathMarkup,
          generateBetweenRoundDiffs,
          progress,
        });
      },
    );

    const { results, totalOperations } = outcome;

    if (totalOperations === 0) {
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
    } else if (successCount < totalOperations) {
      vscode.window.showWarningMessage(
        `${successCount} of ${totalOperations} LaTeX diff operations completed successfully (math markup: "${mathMarkup}")`,
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
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error running LaTeX diffs', err);
  }
}
