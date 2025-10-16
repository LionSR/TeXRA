// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';

// Local imports - latex utils
import { LaTeXdiffService } from '@latex/latexdiff';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  describeMathMarkupOption,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import { checkToolInstalled } from '@utils/system';

// Local imports - housekeeping
import {
  runPackLatexdiffvc,
  runPackLatexdiffvcMultiple,
  runCleanLatexdiffvc,
  runCleanLatexdiffvcMultiple,
} from '@housekeeping';

// Import agent utilities
import { getAgentFirstNameChunk } from '@housekeeping/utils';

// Local imports - errors
import {
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedMessageWithDocs,
} from '@common/errors/errorHandlingUtils';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

const service = new LaTeXdiffService(CHANNEL);

type LatexdiffTool = 'latexdiff' | 'latexdiff-vc';

/**
 * Ensures the required latexdiff tool is installed before running a command.
 * @param tool The tool name to verify.
 * @returns True when the tool is available, false otherwise.
 */
async function ensureLatexdiffToolInstalled(tool: LatexdiffTool): Promise<boolean> {
  if (await checkToolInstalled(tool)) {
    return true;
  }

  logger.warn(CHANNEL, `${tool} is not installed; command will not run.`);
  return false;
}

/**
 * Prompts the user to select a math markup granularity for latexdiff operations.
 * @returns The selected math markup option, or undefined if the user cancels.
 */
async function promptForLatexdiffMathMarkup(): Promise<MathMarkupOption | undefined> {
  const configuredMode = getConfig<string>(
    'latexdiff.mathMarkup',
    DEFAULT_MATH_MARKUP,
  );
  const items: (vscode.QuickPickItem & { value: MathMarkupOption })[] =
    MATH_MARKUP_OPTIONS.map((mode) => ({
      label: mode,
      description: describeMathMarkupOption(mode),
      picked: mode === configuredMode,
      value: mode,
    }));
  const prioritizedItems = [
    ...items.filter((item) => item.value === configuredMode),
    ...items.filter((item) => item.value !== configuredMode),
  ];

  const selection = await vscode.window.showQuickPick(prioritizedItems, {
    title: 'Latexdiff math markup',
    placeHolder: 'Select math markup granularity for this diff run',
    ignoreFocusOut: true,
  });

  return selection?.value;
}

/**
 * Opens a generated latexdiff result in the LaTeX build preview after verifying it exists.
 * @param basePath The base file (or directory) used when generating the diff.
 * @param diffFileName The generated diff file name returned by the service.
 * @returns True when the diff file exists and is opened successfully.
 */
async function openLatexdiffResult(
  basePath: string,
  diffFileName: string,
): Promise<string | undefined> {
  const baseDirectory = path.extname(basePath)
    ? path.dirname(basePath)
    : basePath;
  const diffFilePath = path.join(baseDirectory, diffFileName);

  if (!(await WorkspaceFS.exists(diffFilePath))) {
    await showLoggedMessage(
      CHANNEL,
      `Diff file could not be found. Expected path: ${diffFilePath}`,
    );
    return undefined;
  }

  await openBuildDisplayIfTex(diffFilePath, { preserveFocus: true });
  return diffFilePath;
}

// Removed showLatexdiffError wrapper - using showLoggedMessageWithDocs directly

export function registerLatexdiffCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.latexdiff', handleLatexdiff),
    vscode.commands.registerCommand('texra.latexdiffvc', handleLatexdiffvc),
    vscode.commands.registerCommand(
      'texra.packLatexdiffvc',
      handlePackLatexdiffvc,
    ),
    vscode.commands.registerCommand(
      'texra.packLatexdiffvcMultiple',
      handlePackLatexdiffvcMultiple,
    ),
    vscode.commands.registerCommand(
      'texra.cleanLatexdiffvc',
      handleCleanLatexdiffvc,
    ),
    vscode.commands.registerCommand(
      'texra.cleanLatexdiffvcMultiple',
      handleCleanLatexdiffvcMultiple,
    ),
    vscode.commands.registerCommand('texra.runLatexdiff', handleRunLatexdiff),
  );
}

async function handleLatexdiff(
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  if (!(baseFile || inputFile)) {
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

  const fileToUse = baseFile || inputFile;
  try {
    if (!(await ensureLatexdiffToolInstalled('latexdiff'))) {
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

    // Get the result from LaTeXdiffService
    const result = await service.runDiff(
      fileToUse,
      editedFile,
      '_diff',
      false,
      mathMarkup,
    );

    if (!result.success || !result.diffFileName) {
      throw new Error(result.message || 'Failed to generate diff file');
    }

    await openLatexdiffResult(fileToUse, result.diffFileName);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error creating LaTeX diff', err);
  }
}

async function handleLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  const fileToUse = baseFile || inputFile;
  try {
    if (!(await ensureLatexdiffToolInstalled('latexdiff-vc'))) {
      return;
    }

    const mathMarkup = await promptForLatexdiffMathMarkup();
    if (!mathMarkup) {
      logger.debug(CHANNEL, 'Math markup selection cancelled by user');
      return;
    }
    logger.info(
      CHANNEL,
      `Running latexdiff-vc with math markup mode: ${mathMarkup}`,
    );

    // Get the result from LaTeXdiffService
    const result = await service.runDiffVc(fileToUse, commitHash, mathMarkup);

    if (!result.success || !result.diffFileName) {
      throw new Error(result.message || 'Failed to generate diff file');
    }

    await openLatexdiffResult(fileToUse, result.diffFileName);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error creating LaTeX diff', err);
  }
}

async function handlePackLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
  clean: boolean,
) {
  try {
    if (!(await ensureLatexdiffToolInstalled('latexdiff-vc'))) {
      return;
    }

    logger.debug(
      CHANNEL,
      `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}, clean=${clean}`,
    );
    const fileToUse = baseFile || inputFile;
    await runPackLatexdiffvc(fileToUse, commitHash, clean);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error packing LaTeX diff', err);
  }
}

async function handlePackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean,
) {
  try {
    if (!(await ensureLatexdiffToolInstalled('latexdiff-vc'))) {
      return;
    }

    logger.debug(
      CHANNEL,
      `Command called with: commitHash=${commitHash}, clean=${clean}`,
    );
    logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
    await runPackLatexdiffvcMultiple(inputFiles, commitHash, clean);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error packing LaTeX diffs', err);
  }
}

async function handleCleanLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  try {
    if (!(await ensureLatexdiffToolInstalled('latexdiff-vc'))) {
      return;
    }

    logger.debug(
      CHANNEL,
      `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}`,
    );
    const fileToUse = baseFile || inputFile;
    await runCleanLatexdiffvc(fileToUse, commitHash);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error cleaning LaTeX diff', err);
  }
}

async function handleCleanLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
) {
  try {
    if (!(await ensureLatexdiffToolInstalled('latexdiff-vc'))) {
      return;
    }

    logger.debug(CHANNEL, `Command called with: commitHash=${commitHash}`);
    logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
    await runCleanLatexdiffvcMultiple(inputFiles, commitHash);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error cleaning LaTeX diffs', err);
  }
}

/**
 * Handles the runLatexdiff command triggered from the log view.
 * Performs both round diffs and between-round diffs on existing tex files.
 */
async function handleRunLatexdiff(config: any) {
  try {
    logger.debug(
      CHANNEL,
      `Command called with config: ${JSON.stringify(config)}`,
    );

    if (!(await ensureLatexdiffToolInstalled('latexdiff'))) {
      return;
    }

    // Extract configuration parameters
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

    const generateBetweenRoundDiffs = getConfig<boolean>(
      'latexdiff.generateBetweenRoundDiffs',
      false,
    );
    logger.debug(
      CHANNEL,
      `Between-round diffs enabled: ${generateBetweenRoundDiffs}`,
    );

    // Get the agent name chunk for filename matching
    const agentNameChunk = getAgentFirstNameChunk(agent);
    logger.debug(CHANNEL, `Using agent name chunk: ${agentNameChunk}`);

    // Get workspace path
    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Create a progress indicator
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running LaTeX diffs',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0, message: 'Finding output files...' });

        // Determine the input files (could be multiple)
        let inputFiles: string[] = [];

        if (outputFiles && Array.isArray(outputFiles)) {
          // If we have specified multiple output files, use those as base for comparison
          inputFiles = outputFiles;
        } else {
          // Otherwise, use the single input file
          inputFiles = [inputFile];
        }

        logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);

        // Track file mappings between input files and their corresponding round outputs
        const inputToOutputsMap = new Map<string, Map<number, string>>();

        // Process each input file separately with its own directory
        for (const inputFile of inputFiles) {
          const outputDirPath = path.dirname(inputFile);
          const baseInputName = path.basename(
            inputFile,
            path.extname(inputFile),
          );

          // Find potential output files in this input file's directory
          const outputDir = await vscode.workspace.fs.readDirectory(
            vscode.Uri.file(path.join(workspacePath, outputDirPath)),
          );

          const roundOutputsMap = new Map<number, string>();

          // Regex pattern for matching output files
          // Pattern: [baseInputName]_[agentNameChunk]_r[round]_[model].tex
          const outputFilePattern = new RegExp(
            `${baseInputName}_${agentNameChunk}_r(\\d+)_${model.replace(/\./g, '')}`,
          );

          for (const [fileName, fileType] of outputDir) {
            if (
              fileType === vscode.FileType.File &&
              fileName.endsWith('.tex')
            ) {
              // Skip files that are already diff files (contain "_diff" in name)
              if (fileName.includes('_diff')) {
                continue;
              }

              const match = fileName.match(outputFilePattern);

              if (match) {
                const round = parseInt(match[1], 10);
                roundOutputsMap.set(round, path.join(outputDirPath, fileName));
              }
            }
          }

          if (roundOutputsMap.size > 0) {
            inputToOutputsMap.set(inputFile, roundOutputsMap);
            logger.debug(
              CHANNEL,
              `Found ${roundOutputsMap.size} matching outputs for ${inputFile}`,
            );
          } else {
            logger.debug(CHANNEL, `No matching outputs found for ${inputFile}`);
          }
        }

        if (inputToOutputsMap.size === 0) {
          vscode.window.showInformationMessage(
            'No matching output files found for this configuration',
          );
          return;
        }

        logger.debug(
          CHANNEL,
          `Found matches for ${inputToOutputsMap.size} input files`,
        );

        // Count total operations for progress reporting
        let totalOperations = 0;
        let completedOperations = 0;

        // Count operations for better progress reporting
        for (const [, roundOutputs] of inputToOutputsMap.entries()) {
          // 1. Count round-based diffs (original vs output)
          totalOperations += roundOutputs.size;

          // 2. Count between-rounds diffs
          const rounds = Array.from(roundOutputs.keys()).sort((a, b) => a - b);
          if (generateBetweenRoundDiffs && rounds.length > 1) {
            totalOperations += rounds.length - 1;
          }
        }

        if (totalOperations === 0) {
          vscode.window.showInformationMessage('No files to diff were found');
          return;
        }

        logger.debug(
          CHANNEL,
          `Total diff operations to perform: ${totalOperations}`,
        );

        // Perform all diff operations
        const results: Array<{
          success: boolean;
          message?: string;
          basePath?: string;
          diffFileName?: string;
        }> = [];

        // Process each input file and its outputs
        for (const [inputFile, roundOutputs] of inputToOutputsMap.entries()) {
          progress.report({
            increment: 0,
            message: `Running diffs for ${path.basename(inputFile)}...`,
          });

          // Sort rounds to ensure we process them in order
          const rounds = Array.from(roundOutputs.keys()).sort((a, b) => a - b);

          // 1. First perform round-based diffs
          for (const round of rounds) {
            const outputFile = roundOutputs.get(round)!;

            logger.debug(
              CHANNEL,
              `Running round diff for ${path.basename(inputFile)} -> ${path.basename(outputFile)} (r${round})`,
            );

            // Use the specialized function for round-based diffs
            const result = await service.runDiffForRound(
              inputFile,
              outputFile,
              round,
              mathMarkup,
            );

            results.push({
              success: result.success,
              message: result.message,
              basePath: inputFile,
              diffFileName: result.diffFileName,
            });

            completedOperations++;
            progress.report({
              increment: (completedOperations / totalOperations) * 100,
              message: `Completed ${completedOperations} of ${totalOperations} operations`,
            });
          }

          // 2. Perform between-rounds diffs if there are multiple rounds
          if (generateBetweenRoundDiffs && rounds.length > 1) {
            for (let i = 0; i < rounds.length - 1; i++) {
              const currentRound = rounds[i];
              const nextRound = rounds[i + 1];

              const currentFile = roundOutputs.get(currentRound)!;
              const nextFile = roundOutputs.get(nextRound)!;

              logger.debug(
                CHANNEL,
                `Running between-rounds diff: ${path.basename(currentFile)} -> ${path.basename(nextFile)}`,
              );

              // Use the specialized function for between-rounds diffs
              const result = await service.runDiffBetweenRounds(
                currentFile,
                nextFile,
                mathMarkup,
              );

              results.push({
                success: result.success,
                message: result.message,
                basePath: currentFile,
                diffFileName: result.diffFileName,
              });

              completedOperations++;
              progress.report({
                increment: (completedOperations / totalOperations) * 100,
                message: `Completed ${completedOperations} of ${totalOperations} operations`,
              });
            }
          }
        }

        // Summarize results
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

        // Log detailed results
        for (const result of results) {
          if (result.success && result.basePath && result.diffFileName) {
            const diffFilePath = await openLatexdiffResult(
              result.basePath,
              result.diffFileName,
            );
            if (diffFilePath) {
              logger.debug(
                CHANNEL,
                `Successfully generated diff: ${diffFilePath}`,
              );
            }
          } else {
            logger.warn(CHANNEL, `Failed to generate diff: ${result.message}`);
          }
        }
      },
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error running LaTeX diffs', err);
  }
}

export const latexdiffCommands = {
  handleLatexdiff,
  handleLatexdiffvc,
  handlePackLatexdiffvc,
  handlePackLatexdiffvcMultiple,
  handleCleanLatexdiffvc,
  handleCleanLatexdiffvcMultiple,
  handleRunLatexdiff,
};

export const latexdiffHelpers = {
  ensureLatexdiffToolInstalled,
  promptForLatexdiffMathMarkup,
  openLatexdiffResult,
};
