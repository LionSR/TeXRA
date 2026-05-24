// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { listExecutions } from '@agent/storage';
import {
  WORKFLOW_OUTPUT_BASENAME,
  legacyWorkflowOutputRoundRegex,
  midEraWorkflowOutputStem,
  parseWorkflowOutputRoundDir,
} from '@agent/output/workflowOutputLayout';
import { getStreamTabId } from '@agent/runtime/streamTab';
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
import { LaTeXdiffService } from '@latex/latexdiff';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  describeMathMarkupOption,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import * as logger from '@logger/logUtils';
import { getStreamTabStore } from '@progressView/persistence/StreamTabStore';
import { RoundKeySchema } from '@progressView/persistence/streamTabSchemas';
import { ExecutionIdSchema } from '@shared/schemas';
import type { ExecutionId, OutputFileInfo } from '@shared/schemas';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { getConfig } from '@utils/config';
import {
  WorkspaceFS,
  TaskRunFileService,
  createRunStorageLocation,
  flexibleFS,
  getComparablePath,
  pathToLocation,
  resolveRunDir,
  type FileLocation,
} from '@utils/files';
import { checkToolInstalled } from '@utils/system';
import { hasExtension } from '@utils/core/pathCore';

import {
  getLatexdiffPackNotifications,
  type LatexHousekeepingNotification,
} from './latexHousekeepingNotifications';

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

/**
 * Recursively collect all `.tex` file paths under `dir`, returned as paths
 * relative to `dir` using forward slashes (e.g. `"chapters/main.tex"`).
 */
async function collectTexFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const [name, type] of entries) {
    const absPath = path.join(dir, name);
    // Skip symlinks — they are mirrored dependency copies placed by
    // ensureMirroredInRoundDir, not revised outputs.  Use lstat because
    // some vscode.workspace.fs implementations don't set the SymbolicLink
    // flag in the returned FileType bitmask.
    try {
      if ((await fs.promises.lstat(absPath)).isSymbolicLink()) continue;
    } catch {
      // lstat failed; fall through and include the entry
    }
    const isFile = (type & vscode.FileType.File) !== 0;
    const isDir = (type & vscode.FileType.Directory) !== 0;
    if (isFile) {
      if (hasExtension(name, '.tex')) {
        results.push(prefix ? `${prefix}/${name}` : name);
      }
    } else if (isDir) {
      const sub = await collectTexFiles(
        absPath,
        prefix ? `${prefix}/${name}` : name,
      );
      results.push(...sub);
    }
  }
  return results;
}

/**
 * Read `executions/{runId}/r{round}/output.*` directly from disk and build
 * `OutputFileInfo[]` per round. Used as a recovery fallback when the caller
 * supplies a `runId` but stream-tab metadata is missing or stale — in that
 * case the plain workspace scan would return nothing because the new layout
 * lives inside run storage.
 *
 * Lineage `original` is set to the configured `inputFile` so latexdiff has
 * a base to compare against.
 */
async function scanRunDirForOutputs(
  executionId: ExecutionId,
  inputFile: string,
  extraBaseFiles?: string[],
): Promise<Map<number, OutputFileInfo[]> | null> {
  try {
    const runDirAbsolute = await resolveRunDir(executionId);
    if (!runDirAbsolute) return null;

    const dirEntries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.file(runDirAbsolute),
    );

    const workspacePath = WorkspaceFS.getPath() ?? '';
    const toAbs = (f: string): string =>
      path.isAbsolute(f) ? f : path.join(workspacePath, f);

    // Build a relative-path (no extension) → workspace location map so
    // multi-output runs with duplicate basenames (e.g. chapters/main.tex and
    // appendix/main.tex) don't collide. fileRelToRound mirrors the workspace
    // relative path for XML-extracted files, so the keys match directly.
    const baseLocationByRelPath = new Map<string, FileLocation>();
    for (const bf of [inputFile, ...(extraBaseFiles ?? [])]) {
      const abs = toAbs(bf);
      const rel = (workspacePath ? path.relative(workspacePath, abs) : bf)
        .replaceAll('\\', '/')
        .replace(/\.tex$/i, '');
      baseLocationByRelPath.set(rel, pathToLocation(abs));
    }
    const defaultBaseLocation = pathToLocation(toAbs(inputFile));

    const rounds = new Map<number, OutputFileInfo[]>();

    for (const [entryName, fileType] of dirEntries) {
      if (fileType !== vscode.FileType.Directory) continue;
      const round = parseWorkflowOutputRoundDir(entryName);
      if (round == null) continue;

      const roundDirAbsolute = path.join(runDirAbsolute, entryName);
      const outputs: OutputFileInfo[] = [];
      // Collect .tex files recursively — extracted docs may live in subdirs
      // (e.g. r0/chapters/main.tex) when source names include path segments.
      const allTexFiles = await collectTexFiles(roundDirAbsolute);
      // Between-round artifacts written to run storage always carry both round
      // numbers (e.g. output_diffr1r0.tex). The bare _diff suffix only appears
      // in workspace-side diffs, never here, so a legitimately-named source
      // like "chapter_diff.tex" is not mistakenly dropped.
      const nonArtifact = allTexFiles.filter(
        (f) => !/_diffr\d+r\d+$/.test(path.parse(f).name),
      );
      // Raw round output is output.xml (never collected by collectTexFiles).
      // Guard for pre-refactor runs where non-scratchpad agents wrote output.tex
      // as the raw wrapper: drop it when real extracted outputs exist alongside.
      const rawStem = `${WORKFLOW_OUTPUT_BASENAME}.tex`;
      const texFiles =
        nonArtifact.length > 1 && nonArtifact.includes(rawStem)
          ? nonArtifact.filter((f) => f !== rawStem)
          : nonArtifact;
      for (const fileRelToRound of texFiles) {
        const relativePath = path.join(entryName, fileRelToRound);
        const location = createRunStorageLocation(
          path.join(runDirAbsolute, relativePath),
          relativePath,
          executionId,
        );
        // Preserve subdirectory in source (e.g. "chapters/main") so
        // traceFileLineage can match it back to the workspace original.
        // For the generic "output" stem, fall back to the input file basename
        // so progress labels show the meaningful name instead of "output".
        const sourceNoExt = fileRelToRound.replace(/\.tex$/i, '');
        const source =
          sourceNoExt === WORKFLOW_OUTPUT_BASENAME
            ? path.basename(inputFile)
            : sourceNoExt;
        // Match recovered file to its base by relative path. Fall back to the
        // single configured base only when there's no ambiguity (one candidate);
        // in multi-file runs an unmatched file gets null so it surfaces as a
        // "missing base" error rather than silently diffing against the wrong doc.
        const fileKey = fileRelToRound
          .replaceAll('\\', '/')
          .replace(/\.tex$/i, '');
        const originalLocation =
          baseLocationByRelPath.get(fileKey) ??
          (baseLocationByRelPath.size === 1 ? defaultBaseLocation : null);
        outputs.push({
          source,
          round,
          location,
          lineage: {
            original: originalLocation,
            diffBase: null,
            diffFile: null,
          },
          diff: null,
        });
      }

      if (outputs.length > 0) rounds.set(round, outputs);
    }

    return rounds.size > 0
      ? new Map([...rounds.entries()].sort((a, b) => a[0] - b[0]))
      : null;
  } catch (error) {
    logger.debug(
      CHANNEL,
      `RunDir scan for ${executionId} failed: ${String(error)}`,
    );
    return null;
  }
}

/**
 * When the caller didn't supply `outputsByRound`, look up the most recent
 * execution whose `agent + model + inputFile` match the request and pull
 * its persisted `OutputFileInfo[]` from the stream-tab store. Returns null
 * when no matching execution exists.
 */
async function discoverLatestExecutionOutputs(query: {
  agent: string;
  model: string;
  inputFile: string;
}): Promise<{
  executionId: ExecutionId;
  rounds: Map<number, OutputFileInfo[]>;
} | null> {
  try {
    const executions = await listExecutions();
    // Normalize both sides so trivial path-format differences (duplicate
    // separators, `./`, mixed forward/backslash) don't silently miss a
    // matching execution.
    const normalizedInput = path.normalize(query.inputFile);

    const candidates = executions
      .filter((entry) => {
        if (entry.agent !== query.agent || entry.model !== query.model) {
          return false;
        }
        const entryInput = entry.agentConfig?.inputFiles?.[0];
        return (
          typeof entryInput === 'string' &&
          path.normalize(entryInput) === normalizedInput
        );
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    for (const candidate of candidates) {
      const streamId = getStreamTabId(candidate.agent, candidate.model, {
        executionId: candidate.id,
      });
      const rounds = await getStreamTabStore(streamId).readOutputFiles();
      if (rounds && rounds.size > 0) {
        return { executionId: candidate.id, rounds };
      }
    }
  } catch (error) {
    logger.debug(
      CHANNEL,
      `Metadata-driven latexdiff discovery failed: ${String(error)}`,
    );
  }
  return null;
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

    let discoveredExecutionId = runId;

    // When the caller specifies a runId (progress-toolbar invocations do),
    // scope output discovery to that execution first. Otherwise metadata
    // auto-discovery can return a different, newer run with the same
    // agent/model/inputFile — silently diffing against the wrong outputs.
    if (!outputsByRound && runId) {
      const parsedRunId = ExecutionIdSchema.safeParse(runId);
      if (parsedRunId.success) {
        const scanned = await scanRunDirForOutputs(
          parsedRunId.data,
          inputFile,
          outputFiles,
        );
        if (scanned) {
          outputsByRound = scanned;
          discoveredExecutionId = parsedRunId.data;
          logger.debug(
            CHANNEL,
            `Using run-dir scan outputs from execution ${parsedRunId.data}`,
          );
        }
      }
    }

    // No runId given: fall back to searching executions by
    // agent/model/inputFile and pulling their persisted stream-tab
    // metadata. When the caller pinned a runId but the run-dir scan
    // turned up nothing, DO NOT drop to latest-matching auto-discovery:
    // that would silently diff against a different (usually newer)
    // execution with the same agent/model/input.
    if (!outputsByRound && !runId) {
      const discovered = await discoverLatestExecutionOutputs({
        agent,
        model,
        inputFile,
      });
      if (discovered) {
        outputsByRound = discovered.rounds;
        discoveredExecutionId = discovered.executionId;
        logger.debug(
          CHANNEL,
          `Using metadata outputs from execution ${discovered.executionId}`,
        );
      }
    }

    const fileService = new TaskRunFileService(discoveredExecutionId);

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
    info.source ?? path.basename(getComparablePath(info.location));

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

      const key = getComparablePath(info.location);
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
    // `<base>_<chunk>_r{round}_<normalizedModel>.tex`.
    const legacyPattern = legacyWorkflowOutputRoundRegex(
      baseInputName,
      agent,
      model,
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

    // Mid-era layout: outputs under `r{round}/<base>_<cleanAgent>_<model>.tex`.
    // Some upgraded workspaces may still hold these files. Only look in
    // known `r{round}/` subdirectories so we don't descend the whole tree.
    const midEraFilename = `${midEraWorkflowOutputStem({
      base: baseInputName,
      agent,
      model,
    })}.tex`;
    for (const [entryName, entryType] of dirEntries) {
      if (entryType !== vscode.FileType.Directory) continue;
      const round = parseWorkflowOutputRoundDir(entryName);
      if (round == null) continue;
      if (roundOutputsMap.has(round)) continue;

      const roundAbsoluteDir = path.join(absoluteDir, entryName);
      let roundEntries: [string, vscode.FileType][];
      try {
        roundEntries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.file(roundAbsoluteDir),
        );
      } catch {
        continue;
      }
      const match = roundEntries.find(
        ([fileName, nestedType]) =>
          nestedType === vscode.FileType.File && fileName === midEraFilename,
      );
      if (!match) continue;
      roundOutputsMap.set(
        round,
        path.join(outputDirPath, entryName, midEraFilename),
      );
    }

    // New-layout workflow outputs live inside task-run storage
    // (`executions/{id}/r{round}/output.tex`), not in the workspace. That
    // path is driven by execution metadata (`OutputFileInfo.outputsByRound`)
    // via `runLatexdiffFromMetadata`; the workspace scan here only covers
    // pre-refactor files.

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
