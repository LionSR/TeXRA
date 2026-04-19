// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedMessageWithDocs,
} from '@common/errors';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import {
  runPackLatexdiffvc,
  runPackLatexdiffvcMultiple,
  runCleanLatexdiffvc,
  runCleanLatexdiffvcMultiple,
} from '@housekeeping';
import { getCleanAgentName } from '@agent/index';
import { getAgentFirstNameChunk } from '@housekeeping/utils';
import { LaTeXdiffService } from '@latex/latexdiff';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  describeMathMarkupOption,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import * as logger from '@logger/logUtils';
import { RoundKeySchema } from '@progressView/persistence/streamTabSchemas';
import type { OutputFileInfo } from '@shared/schemas';
import { getConfig } from '@utils/config';
import {
  WorkspaceFS,
  TaskRunFileService,
  flexibleFS,
  pathToLocation,
  type FileLocation,
} from '@utils/files';
import { checkToolInstalled } from '@utils/system';
import { hasExtension } from '@utils/core/pathCore';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

const service = new LaTeXdiffService(CHANNEL);

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

export function registerLatexdiffCommands(
  context: vscode.ExtensionContext,
): void {
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
      await runPackLatexdiffvc(fileToUse, commitHash, clean);
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
      await runPackLatexdiffvcMultiple(inputFiles, commitHash, clean);
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
      await runCleanLatexdiffvc(fileToUse, commitHash);
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
      await runCleanLatexdiffvcMultiple(inputFiles, commitHash);
    },
  );
}

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

        if (outputsByRound) {
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

async function executeDiffOperations(
  operations: DiffOperation[],
  mathMarkup: MathMarkupOption | undefined,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  immediateResults: DiffRunResult[] = [],
): Promise<DiffRunOutcome> {
  const results: DiffRunResult[] = [...immediateResults];
  const incrementPct = operations.length > 0 ? 100 / operations.length : 0;

  for (const operation of operations) {
    progress.report({
      increment: incrementPct,
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

    const diffResult =
      operation.type === 'round'
        ? await service.runDiffForRound(
            operation.base,
            operation.revised,
            operation.round ?? 0,
            mathMarkup,
            { cwd: operation.cwd },
          )
        : await service.runDiffBetweenRounds(
            operation.base,
            operation.revised,
            mathMarkup,
            { cwd: operation.cwd },
          );

    results.push({
      success: diffResult.success,
      message: diffResult.message,
      basePath: operation.base.absolutePath,
      diffFileName: diffResult.diffFileName,
      description: operation.description,
    });
  }

  return { results, totalOperations: results.length };
}

async function runLatexdiffFromMetadata(params: {
  rounds: Map<number, OutputFileInfo[]>;
  mathMarkup?: MathMarkupOption;
  generateBetweenRoundDiffs: boolean;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  fileService: TaskRunFileService;
}): Promise<DiffRunOutcome> {
  const { rounds, mathMarkup, generateBetweenRoundDiffs, progress } = params;

  const getFileLabel = (info: OutputFileInfo): string =>
    info.source ??
    path.basename(
      info.location.kind === 'external'
        ? info.location.absolutePath
        : info.location.relativePath,
    );

  const immediateResults: DiffRunResult[] = [];
  const operations: DiffOperation[] = [];
  const groupedByRelative = new Map<
    string,
    Array<{ round: number; info: OutputFileInfo }>
  >();

  for (const [round, infos] of rounds.entries()) {
    for (const info of infos) {
      const base = info.lineage?.original ?? null;
      const description = `${getFileLabel(info)} (r${round})`;

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
        revised: info.location,
        description,
        cwd: WorkspaceFS.getPath() ?? path.dirname(base.absolutePath),
        round,
      });

      const key =
        info.location.kind === 'external'
          ? info.location.absolutePath
          : info.location.relativePath;
      if (!groupedByRelative.has(key)) {
        groupedByRelative.set(key, []);
      }
      groupedByRelative.get(key)!.push({ round, info });
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
        const description = `${getFileLabel(current.info)} (r${previous.round}→r${current.round})`;

        operations.push({
          type: 'between-rounds',
          base,
          revised,
          description,
          cwd: WorkspaceFS.getPath() ?? path.dirname(base.absolutePath),
          fromRound: previous.round,
          toRound: current.round,
        });
      }
    }
  }

  return executeDiffOperations(
    operations,
    mathMarkup,
    progress,
    immediateResults,
  );
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
  const cleanAgent = getCleanAgentName(agent);
  const normalizedModel = model.replaceAll('.', '');
  logger.debug(CHANNEL, `Using agent name chunk: ${agentNameChunk}`);

  const configuredInputFiles =
    outputFiles && outputFiles.length > 0 ? outputFiles : [inputFile];

  logger.debug(CHANNEL, `Input files: ${configuredInputFiles.join(', ')}`);

  const inputToOutputsMap = new Map<string, Map<number, string>>();

  for (const candidateInput of configuredInputFiles) {
    const outputDirPath = path.dirname(candidateInput);
    const baseInputName = path.basename(
      candidateInput,
      path.extname(candidateInput),
    );

    const absoluteDir = path.join(workspacePath, outputDirPath);
    const dirEntries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.file(absoluteDir),
    );

    const roundOutputsMap = new Map<number, string>();

    // Legacy flat layout: files sit directly under outputDirPath as
    // `<base>_<chunk>_r{round}_<model>.tex`.
    const legacyPattern = new RegExp(
      `${baseInputName}_${agentNameChunk}_r(\\d+)_${normalizedModel}`,
    );
    for (const [fileName, fileType] of dirEntries) {
      if (
        fileType !== vscode.FileType.File ||
        !hasExtension(fileName, '.tex') ||
        fileName.includes('_diff')
      ) {
        continue;
      }
      const match = fileName.match(legacyPattern);
      if (!match) continue;
      const round = RoundKeySchema.safeParse(match[1]);
      if (!round.success) continue;
      roundOutputsMap.set(round.data, path.join(outputDirPath, fileName));
    }

    // New layout: files sit under `<outputDirPath>/r{round}/` as
    // `<base>_<cleanAgent>_<model>.tex`. The model is written verbatim
    // (dots preserved), so escape regex metachars rather than stripping.
    const escapedModel = model.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&');
    const newLayoutFileName = new RegExp(
      `^${baseInputName}_${cleanAgent}_${escapedModel}\\.tex$`,
    );
    for (const [subName, subType] of dirEntries) {
      if (subType !== vscode.FileType.Directory) continue;
      const roundMatch = subName.match(/^r(\d+)$/);
      if (!roundMatch) continue;
      const round = RoundKeySchema.safeParse(roundMatch[1]);
      if (!round.success) continue;

      const roundDirAbs = path.join(absoluteDir, subName);
      let roundEntries: [string, vscode.FileType][];
      try {
        roundEntries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.file(roundDirAbs),
        );
      } catch {
        continue;
      }
      for (const [fileName, fileType] of roundEntries) {
        if (
          fileType !== vscode.FileType.File ||
          fileName.includes('_diff') ||
          !newLayoutFileName.test(fileName)
        ) {
          continue;
        }
        roundOutputsMap.set(
          round.data,
          path.join(outputDirPath, subName, fileName),
        );
      }
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

  const operations: DiffOperation[] = [];

  for (const [baseFile, roundOutputs] of inputToOutputsMap.entries()) {
    const rounds = [...roundOutputs.keys()].sort((a, b) => a - b);

    for (const round of rounds) {
      const outputFile = roundOutputs.get(round)!;
      const resolvedBase = path.isAbsolute(baseFile)
        ? baseFile
        : path.join(workspacePath, baseFile);
      const resolvedOutput = path.isAbsolute(outputFile)
        ? outputFile
        : path.join(workspacePath, outputFile);

      operations.push({
        type: 'round',
        base: pathToLocation(resolvedBase),
        revised: pathToLocation(resolvedOutput),
        description: `${path.basename(baseFile)} (r${round})`,
        cwd: path.dirname(resolvedOutput),
        round,
      });
    }

    if (generateBetweenRoundDiffs && rounds.length > 1) {
      for (let index = 0; index < rounds.length - 1; index += 1) {
        const currentRound = rounds[index];
        const nextRound = rounds[index + 1];
        const currentFile = roundOutputs.get(currentRound)!;
        const nextFile = roundOutputs.get(nextRound)!;

        const resolvedCurrent = path.isAbsolute(currentFile)
          ? currentFile
          : path.join(workspacePath, currentFile);
        const resolvedNext = path.isAbsolute(nextFile)
          ? nextFile
          : path.join(workspacePath, nextFile);

        operations.push({
          type: 'between-rounds',
          base: pathToLocation(resolvedCurrent),
          revised: pathToLocation(resolvedNext),
          description: `${path.basename(currentFile)} (r${currentRound}→r${nextRound})`,
          cwd: path.dirname(resolvedCurrent),
          fromRound: currentRound,
          toRound: nextRound,
        });
      }
    }
  }

  return executeDiffOperations(operations, mathMarkup, progress);
}
