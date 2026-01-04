// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import type { OutputFileInfo } from '@agent/output/types';

// Internal imports
import {
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedMessageWithDocs,
} from '@common/errors';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';
import {
  WorkspaceFS,
  TaskRunFileService,
  flexibleFS,
  pathToLocation,
  type FileLocation,
} from '@utils/files';
import { checkToolInstalled } from '@utils/system';
import { LaTeXdiffService, type LaTeXdiffResult } from '@latex/latexdiff';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  describeMathMarkupOption,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import {
  runPackLatexdiffvc,
  runPackLatexdiffvcMultiple,
  runCleanLatexdiffvc,
  runCleanLatexdiffvcMultiple,
} from '@housekeeping';
import { getAgentFirstNameChunk } from '@housekeeping/utils';

// Local imports - agent types

// Local imports - errors

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

const service = new LaTeXdiffService(CHANNEL);

type LatexdiffTool = 'latexdiff' | 'latexdiff-vc';

/**
 * Ensures the required latexdiff tool is installed before running a command.
 * @param tool The tool name to verify.
 * @returns True when the tool is available, false otherwise.
 */
async function ensureLatexdiffToolInstalled(
  tool: LatexdiffTool,
): Promise<boolean> {
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
async function promptForLatexdiffMathMarkup(): Promise<
  MathMarkupOption | undefined
> {
  const configuredMode = getConfig<string>(
    'texra.latexdiff.mathMarkup',
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
 * @param base The base file location used when generating the diff.
 * @param diffFileName The generated diff file name returned by the service.
 * @returns The diff file path when successfully opened.
 */
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

  const fileToUse = baseFile ?? inputFile;
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
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error creating LaTeX diff', err);
  }
}

async function handleLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  const fileToUse = baseFile ?? inputFile;
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
    const fileToUse = baseFile ?? inputFile;
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
    const fileToUse = baseFile ?? inputFile;
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
interface RunLatexdiffCommandConfig {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  outputFilesActive?: string[];
  streamId?: string;
  runId?: string | null;
  outputsByRound?: Record<string, OutputFileInfo[]>;
}

interface DiffRunResult {
  success: boolean;
  message?: string;
  basePath?: string;
  diffFileName?: string;
  description?: string;
}

interface DiffRunOutcome {
  results: DiffRunResult[];
  totalOperations: number;
}

type DiffOperationType = 'round' | 'between-rounds';

interface DiffOperation {
  type: DiffOperationType;
  base: FileLocation;
  revised: FileLocation;
  description: string;
  cwd?: string;
  round?: number;
  fromRound?: number;
  toRound?: number;
  info: OutputFileInfo;
  prevInfo?: OutputFileInfo;
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

    const generateBetweenRoundDiffs = getConfig<boolean>(
      'texra.latexdiff.generateBetweenRoundDiffs',
      false,
    );
    logger.debug(
      CHANNEL,
      `Between-round diffs enabled: ${generateBetweenRoundDiffs}`,
    );

    const runId =
      typeof config.runId === 'string' && config.runId.length > 0
        ? config.runId
        : undefined;
    const outputsByRound = normalizeOutputsByRound(config.outputsByRound);
    const fileService = new TaskRunFileService(runId);

    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running LaTeX diffs',
        cancellable: false,
      },
      async (progress): Promise<DiffRunOutcome> => {
        progress.report({
          increment: 0,
          message: outputsByRound
            ? 'Preparing metadata-driven LaTeX diffs...'
            : 'Scanning workspace for LaTeX outputs...',
        });

        if (outputsByRound && outputsByRound.size > 0) {
          return runLatexdiffFromMetadata({
            rounds: outputsByRound,
            mathMarkup,
            generateBetweenRoundDiffs,
            progress,
            fileService,
          });
        }

        return runLatexdiffViaWorkspaceScan({
          agent,
          model,
          inputFile,
          outputFiles,
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
      if (result.success && result.basePath && result.diffFileName) {
        const diffFilePath = await openLatexdiffResult(
          pathToLocation(result.basePath),
          result.diffFileName,
        );
        if (diffFilePath) {
          const suffix = result.description ? ` (${result.description})` : '';
          logger.debug(
            CHANNEL,
            `Successfully generated diff: ${diffFilePath}${suffix}`,
          );
        }
      } else if (!result.success) {
        const suffix = result.description ? ` (${result.description})` : '';
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

function normalizeOutputsByRound(
  raw?: Record<string, OutputFileInfo[]> | null,
): Map<number, OutputFileInfo[]> | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const entries = Object.entries(raw);
  const roundMap = new Map<number, OutputFileInfo[]>();

  for (const [roundKey, value] of entries) {
    const round = Number.parseInt(roundKey, 10);
    if (Number.isNaN(round) || !Array.isArray(value) || value.length === 0) {
      continue;
    }
    roundMap.set(round, value);
  }

  if (roundMap.size === 0) {
    return null;
  }

  return new Map([...roundMap.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Get file description for display - trust source field.
 */
function describeFile(info: OutputFileInfo): string {
  if (info.source) {
    return info.source;
  }
  if (
    info.location.kind === 'workspace' ||
    info.location.kind === 'runStorage'
  ) {
    return path.basename(info.location.relativePath);
  }
  return path.basename(info.location.absolutePath);
}

async function runLatexdiffFromMetadata(params: {
  rounds: Map<number, OutputFileInfo[]>;
  mathMarkup?: MathMarkupOption;
  generateBetweenRoundDiffs: boolean;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  fileService: TaskRunFileService;
}): Promise<DiffRunOutcome> {
  const { rounds, mathMarkup, generateBetweenRoundDiffs, progress } = params;

  const immediateResults: DiffRunResult[] = [];
  const operations: DiffOperation[] = [];
  const groupedByRelative = new Map<
    string,
    Array<{ round: number; info: OutputFileInfo }>
  >();

  for (const [round, infos] of rounds.entries()) {
    for (const info of infos) {
      const revised = info.location;
      // lineage.original is already a FileLocation | null - use directly
      const base = info.lineage?.original ?? null;
      const description = `${describeFile(info)} (r${round})`;

      if (!base) {
        immediateResults.push({
          success: false,
          message: 'Missing base file path',
          description,
        });
        continue;
      }

      operations.push({
        type: 'round',
        base,
        revised,
        description,
        cwd: WorkspaceFS.getPath() ?? path.dirname(base.absolutePath),
        round,
        info,
      });

      const key =
        info.location.kind === 'workspace' ||
        info.location.kind === 'runStorage'
          ? info.location.relativePath
          : info.location.absolutePath;
      let group = groupedByRelative.get(key);
      if (!group) {
        group = [];
        groupedByRelative.set(key, group);
      }
      group.push({ round, info });
    }
  }

  if (generateBetweenRoundDiffs) {
    for (const group of groupedByRelative.values()) {
      group.sort((a, b) => a.round - b.round);
      for (let index = 1; index < group.length; index += 1) {
        const previous = group[index - 1];
        const current = group[index];
        const base = previous.info.location;
        const revised = current.info.location;
        const description = `${describeFile(current.info)} (r${previous.round}→r${current.round})`;

        operations.push({
          type: 'between-rounds',
          base,
          revised,
          description,
          cwd: WorkspaceFS.getPath() ?? path.dirname(base.absolutePath),
          fromRound: previous.round,
          toRound: current.round,
          info: current.info,
          prevInfo: previous.info,
        });
      }
    }
  }

  const results: DiffRunResult[] = [...immediateResults];
  const operationCount = operations.length;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    progress.report({
      increment: operationCount > 0 ? 100 / operationCount : 0,
      message: `Running ${operation.type} diff for ${operation.description}`,
    });

    const baseExists = await flexibleFS.exists(operation.base);
    const revisedExists = await flexibleFS.exists(operation.revised);

    if (!baseExists || !revisedExists) {
      results.push({
        success: false,
        message: 'Required files are missing on disk',
        description: operation.description,
      });
      continue;
    }

    logger.debug(
      CHANNEL,
      `Running ${operation.type} diff: ${operation.description}`,
    );

    let diffResult: LaTeXdiffResult;

    if (operation.type === 'round') {
      diffResult = await service.runDiffForRound(
        operation.base,
        operation.revised,
        operation.round ?? 0,
        mathMarkup,
        { cwd: operation.cwd },
      );
    } else {
      diffResult = await service.runDiffBetweenRounds(
        operation.base,
        operation.revised,
        mathMarkup,
        { cwd: operation.cwd },
      );
    }

    results.push({
      success: diffResult.success,
      message: diffResult.message,
      basePath: operation.base.absolutePath,
      diffFileName: diffResult.diffFileName,
      description: operation.description,
    });
  }

  return {
    results,
    totalOperations: operationCount + immediateResults.length,
  };
}

async function runLatexdiffViaWorkspaceScan(params: {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  mathMarkup?: MathMarkupOption;
  generateBetweenRoundDiffs: boolean;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
}): Promise<DiffRunOutcome> {
  const {
    agent,
    model,
    inputFile,
    outputFiles,
    mathMarkup,
    generateBetweenRoundDiffs,
    progress,
  } = params;

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new Error('No workspace path found');
  }

  const agentNameChunk = getAgentFirstNameChunk(agent);
  logger.debug(CHANNEL, `Using agent name chunk: ${agentNameChunk}`);

  const configuredInputFiles =
    outputFiles && Array.isArray(outputFiles) && outputFiles.length > 0
      ? outputFiles
      : [inputFile];

  logger.debug(CHANNEL, `Input files: ${configuredInputFiles.join(', ')}`);

  const inputToOutputsMap = new Map<string, Map<number, string>>();

  for (const candidateInput of configuredInputFiles) {
    const outputDirPath = path.dirname(candidateInput);
    const baseInputName = path.basename(
      candidateInput,
      path.extname(candidateInput),
    );

    const dirEntries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.file(path.join(workspacePath, outputDirPath)),
    );

    const roundOutputsMap = new Map<number, string>();
    const outputFilePattern = new RegExp(
      `${baseInputName}_${agentNameChunk}_r(\\d+)_${model.replaceAll('.', '')}`,
    );

    for (const [fileName, fileType] of dirEntries) {
      if (fileType !== vscode.FileType.File || !fileName.endsWith('.tex')) {
        continue;
      }

      if (fileName.includes('_diff')) {
        continue;
      }

      const match = fileName.match(outputFilePattern);
      if (!match) {
        continue;
      }

      const round = Number.parseInt(match[1], 10);
      if (Number.isNaN(round)) {
        continue;
      }
      roundOutputsMap.set(round, path.join(outputDirPath, fileName));
    }

    if (roundOutputsMap.size > 0) {
      inputToOutputsMap.set(candidateInput, roundOutputsMap);
      logger.debug(
        CHANNEL,
        `Found ${roundOutputsMap.size} matching outputs for ${candidateInput}`,
      );
    } else {
      logger.debug(CHANNEL, `No matching outputs found for ${candidateInput}`);
    }
  }

  if (inputToOutputsMap.size === 0) {
    return { results: [], totalOperations: 0 };
  }

  let totalOperations = 0;
  for (const [, roundOutputs] of inputToOutputsMap.entries()) {
    totalOperations += roundOutputs.size;

    const rounds = [...roundOutputs.keys()].sort((a, b) => a - b);
    if (generateBetweenRoundDiffs && rounds.length > 1) {
      totalOperations += rounds.length - 1;
    }
  }

  if (totalOperations === 0) {
    return { results: [], totalOperations: 0 };
  }

  logger.debug(CHANNEL, `Total diff operations to perform: ${totalOperations}`);

  const results: DiffRunResult[] = [];
  let completedOperations = 0;

  for (const [baseFile, roundOutputs] of inputToOutputsMap.entries()) {
    progress.report({
      increment: 0,
      message: `Running diffs for ${path.basename(baseFile)}...`,
    });

    const rounds = [...roundOutputs.keys()].sort((a, b) => a - b);

    for (const round of rounds) {
      const outputFile = roundOutputs.get(round)!;
      logger.debug(
        CHANNEL,
        `Running round diff for ${path.basename(baseFile)} -> ${path.basename(outputFile)} (r${round})`,
      );

      const resolvedBase = path.isAbsolute(baseFile)
        ? baseFile
        : path.join(workspacePath, baseFile);
      const resolvedOutput = path.isAbsolute(outputFile)
        ? outputFile
        : path.join(workspacePath, outputFile);
      const cwd = path.dirname(resolvedOutput);

      const result = await service.runDiffForRound(
        pathToLocation(resolvedBase),
        pathToLocation(resolvedOutput),
        round,
        mathMarkup,
        { cwd },
      );

      results.push({
        success: result.success,
        message: result.message,
        basePath: resolvedBase,
        diffFileName: result.diffFileName,
        description: `${path.basename(baseFile)} (r${round})`,
      });

      completedOperations += 1;
      progress.report({
        increment: 100 / totalOperations,
        message: `Completed ${completedOperations} of ${totalOperations} operations`,
      });
    }

    if (generateBetweenRoundDiffs && rounds.length > 1) {
      for (let index = 0; index < rounds.length - 1; index += 1) {
        const currentRound = rounds[index];
        const nextRound = rounds[index + 1];
        const currentFile = roundOutputs.get(currentRound)!;
        const nextFile = roundOutputs.get(nextRound)!;

        logger.debug(
          CHANNEL,
          `Running between-rounds diff: ${path.basename(currentFile)} -> ${path.basename(nextFile)}`,
        );

        const resolvedCurrent = path.isAbsolute(currentFile)
          ? currentFile
          : path.join(workspacePath, currentFile);
        const resolvedNext = path.isAbsolute(nextFile)
          ? nextFile
          : path.join(workspacePath, nextFile);
        const cwd = path.dirname(resolvedCurrent);

        const result = await service.runDiffBetweenRounds(
          pathToLocation(resolvedCurrent),
          pathToLocation(resolvedNext),
          mathMarkup,
          { cwd },
        );

        results.push({
          success: result.success,
          message: result.message,
          basePath: resolvedCurrent,
          diffFileName: result.diffFileName,
          description: `${path.basename(currentFile)} (r${currentRound}→r${nextRound})`,
        });

        completedOperations += 1;
        progress.report({
          increment: 100 / totalOperations,
          message: `Completed ${completedOperations} of ${totalOperations} operations`,
        });
      }
    }
  }

  return { results, totalOperations };
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
