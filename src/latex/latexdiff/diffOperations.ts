/**
 * Build and execute latexdiff operations from either run metadata
 * (`OutputFileInfo` per round) or a workspace scan of legacy/mid-era layouts.
 */

// Node imports
import * as path from 'node:path';

// Local imports
import type { MathMarkupOption } from '@latex/latexdiff/mathMarkup';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import {
  getEffectiveDiffBase,
  roundIndexedEntries,
  RoundKeySchema,
} from '@shared/schemas';
import type { OutputFileInfo, RoundIndexed } from '@shared/schemas';
import {
  legacyWorkflowOutputRoundRegex,
  midEraWorkflowOutputStem,
  parseWorkflowOutputRoundDir,
} from '@shared/constants/workflowOutput';
import { getSafeDocumentRelativePath } from '@utils/files/outputFileUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { hasExtension } from '@utils/core/pathCore';
import { isDirectory, isFile, isSymlink } from '@utils/files/fsEntryType';

// Local file imports
import type {
  DiffOperation,
  DiffProgressReporter,
  DiffRunOutcome,
  DiffRunResult,
  LatexdiffRuntime,
} from './types';

function getCanonicalSource(info: OutputFileInfo): string {
  return getSafeDocumentRelativePath(info.source);
}

async function executeDiffOperations(
  operations: DiffOperation[],
  mathMarkup: MathMarkupOption | undefined,
  latexdiff: LatexdiffRuntime,
  progress: DiffProgressReporter,
  immediateResults: DiffRunResult[] = [],
): Promise<DiffRunOutcome> {
  const results: DiffRunResult[] = [...immediateResults];
  const incrementPct = operations.length > 0 ? 100 / operations.length : 0;

  for (const operation of operations) {
    progress.report({
      increment: incrementPct,
      message: `Running ${operation.type} diff for ${operation.description}`,
    });

    const baseExists = await AbsoluteFS.exists(operation.base.absolutePath);
    const revisedExists = await AbsoluteFS.exists(
      operation.revised.absolutePath,
    );

    if (!baseExists || !revisedExists) {
      results.push({
        success: false,
        message: 'Required files are missing on disk',
        description: operation.description,
      });
      continue;
    }

    logger.debug(
      latexdiff.channel,
      `Running ${operation.type} diff: ${operation.description}`,
    );

    const diffResult =
      operation.type === 'round'
        ? await latexdiff.service.runDiffForRound(
            operation.base,
            operation.revised,
            operation.round,
            mathMarkup,
            { cwd: operation.cwd },
          )
        : await latexdiff.service.runDiffBetweenRounds(
            operation.base,
            operation.revised,
            operation.fromRound,
            operation.toRound,
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

  return { results };
}

export async function runLatexdiffFromMetadata(params: {
  rounds: RoundIndexed<OutputFileInfo>;
  mathMarkup?: MathMarkupOption;
  generateBetweenRoundDiffs: boolean;
  latexdiff: LatexdiffRuntime;
  progress: DiffProgressReporter;
}): Promise<DiffRunOutcome> {
  const { rounds, mathMarkup, generateBetweenRoundDiffs, latexdiff, progress } =
    params;

  const workspaceCwd = WorkspaceFS.getPath();
  const immediateResults: DiffRunResult[] = [];
  const operations: DiffOperation[] = [];
  const groupedBySource = new Map<
    string,
    Array<{ round: number; info: OutputFileInfo }>
  >();

  for (const [round, infos] of roundIndexedEntries(rounds)) {
    for (const info of infos) {
      const base = getEffectiveDiffBase(info.lineage);
      const source = getCanonicalSource(info);
      const description = `${source} (r${round})`;

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
        cwd: workspaceCwd ?? path.dirname(base.absolutePath),
        round,
      });

      const group = groupedBySource.get(source) ?? [];
      group.push({ round, info });
      groupedBySource.set(source, group);
    }
  }

  if (generateBetweenRoundDiffs) {
    for (const group of groupedBySource.values()) {
      group.sort((a, b) => a.round - b.round);
      for (const [index, current] of group.slice(1).entries()) {
        const previous = group[index];
        const base = previous.info.location;
        const revised = current.info.location;
        const description = `${getCanonicalSource(current.info)} (r${previous.round}→r${current.round})`;

        operations.push({
          type: 'between-rounds',
          base,
          revised,
          description,
          cwd: workspaceCwd ?? path.dirname(base.absolutePath),
          fromRound: previous.round,
          toRound: current.round,
        });
      }
    }
  }

  return executeDiffOperations(
    operations,
    mathMarkup,
    latexdiff,
    progress,
    immediateResults,
  );
}

export async function runLatexdiffViaWorkspaceScan(params: {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  mathMarkup?: MathMarkupOption;
  generateBetweenRoundDiffs: boolean;
  latexdiff: LatexdiffRuntime;
  progress: DiffProgressReporter;
}): Promise<DiffRunOutcome> {
  const {
    agent,
    model,
    inputFile,
    outputFiles,
    mathMarkup,
    generateBetweenRoundDiffs,
    latexdiff,
    progress,
  } = params;

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new Error('No workspace path found');
  }

  const fs = platform().fs;
  const toAbsolute = (file: string): string =>
    path.isAbsolute(file) ? file : path.join(workspacePath, file);

  const configuredInputFiles =
    outputFiles && outputFiles.length > 0 ? outputFiles : [inputFile];

  logger.debug(
    latexdiff.channel,
    `Input files: ${configuredInputFiles.join(', ')}`,
  );

  // Per input file: round number → workspace-relative output path. A round
  // matched more than once (e.g. two legacy files matching the same round
  // regex) keeps a single entry, last match wins.
  const inputToOutputsMap = new Map<string, Map<number, string>>();

  for (const candidateInput of configuredInputFiles) {
    const outputDirPath = path.dirname(candidateInput);
    const baseInputName = path.basename(
      candidateInput,
      path.extname(candidateInput),
    );

    const absoluteDir = path.join(workspacePath, outputDirPath);
    const dirEntries = await fs.readDirectory(absoluteDir);

    const roundOutputs = new Map<number, string>();

    // Legacy flat layout: files sit directly under outputDirPath as
    // `<base>_<chunk>_r{round}_<normalizedModel>.tex`.
    const legacyPattern = legacyWorkflowOutputRoundRegex(
      baseInputName,
      agent,
      model,
    );
    for (const [fileName, fileType] of dirEntries) {
      // Skip symlinks (mirrored dependency copies, not revised outputs) so
      // behavior matches the prior strict `=== FileType.File` check; the
      // platform FS reports a symlink as `SymbolicLink | targetType`.
      if (
        !isFile(fileType) ||
        isSymlink(fileType) ||
        !hasExtension(fileName, '.tex') ||
        fileName.includes('_diff')
      ) {
        continue;
      }
      const match = fileName.match(legacyPattern);
      if (!match) continue;
      const round = RoundKeySchema.safeParse(match[1]);
      if (!round.success) continue;
      roundOutputs.set(round.data, path.join(outputDirPath, fileName));
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
      if (!isDirectory(entryType) || isSymlink(entryType)) continue;
      const round = parseWorkflowOutputRoundDir(entryName);
      if (round == null) continue;
      if (roundOutputs.has(round)) continue;

      const roundAbsoluteDir = path.join(absoluteDir, entryName);
      let roundEntries: [string, number][];
      try {
        roundEntries = await fs.readDirectory(roundAbsoluteDir);
      } catch (error) {
        // Skip unreadable round dirs but record which one so a missing
        // round output isn't silently invisible during diagnosis.
        logger.debug(
          latexdiff.channel,
          `Skipping round dir '${roundAbsoluteDir}': ${error}`,
        );
        continue;
      }
      const match = roundEntries.find(
        ([fileName, nestedType]) =>
          isFile(nestedType) &&
          !isSymlink(nestedType) &&
          fileName === midEraFilename,
      );
      if (!match) continue;
      roundOutputs.set(
        round,
        path.join(outputDirPath, entryName, midEraFilename),
      );
    }

    // New-layout workflow outputs live inside task-run storage
    // (`executions/{id}/r{round}/output.tex`), not in the workspace. That
    // path is driven by execution metadata (`OutputFileInfo.outputsByRound`)
    // via `runLatexdiffFromMetadata`; the workspace scan here only covers
    // pre-refactor files.

    if (roundOutputs.size > 0) {
      inputToOutputsMap.set(candidateInput, roundOutputs);
      logger.debug(
        latexdiff.channel,
        `Found ${roundOutputs.size} matching outputs for ${candidateInput}`,
      );
    } else {
      logger.debug(
        latexdiff.channel,
        `No matching outputs found for ${candidateInput}`,
      );
    }
  }

  if (inputToOutputsMap.size === 0) {
    return { results: [] };
  }

  const operations: DiffOperation[] = [];

  for (const [baseFile, roundOutputs] of inputToOutputsMap.entries()) {
    const sorted = [...roundOutputs].sort(([a], [b]) => a - b);

    for (const [round, outputPath] of sorted) {
      const resolvedOutput = toAbsolute(outputPath);

      operations.push({
        type: 'round',
        base: pathToLocation(toAbsolute(baseFile)),
        revised: pathToLocation(resolvedOutput),
        description: `${path.basename(baseFile)} (r${round})`,
        cwd: path.dirname(resolvedOutput),
        round,
      });
    }

    if (generateBetweenRoundDiffs) {
      for (const [index, [toRound, currentPath]] of sorted.slice(1).entries()) {
        const [fromRound, previousPath] = sorted[index];
        const resolvedPrevious = toAbsolute(previousPath);

        operations.push({
          type: 'between-rounds',
          base: pathToLocation(resolvedPrevious),
          revised: pathToLocation(toAbsolute(currentPath)),
          description: `${path.basename(previousPath)} (r${fromRound}→r${toRound})`,
          cwd: path.dirname(resolvedPrevious),
          fromRound,
          toRound,
        });
      }
    }
  }

  return executeDiffOperations(operations, mathMarkup, latexdiff, progress);
}
