/**
 * Build and execute latexdiff operations from either run metadata
 * (`OutputFileInfo` per round) or a workspace scan of legacy/mid-era layouts.
 */

// Standard library imports
import * as path from 'node:path';

// Local imports
import { platform } from '@platform/platform';
import {
  legacyWorkflowOutputRoundRegex,
  midEraWorkflowOutputStem,
  parseWorkflowOutputRoundDir,
} from '@agent/output/workflowOutputLayout';
import type { MathMarkupOption } from '@latex/latexdiff/mathMarkup';
import * as logger from '@logger/logUtils';
import { getEffectiveDiffBase, RoundKeySchema } from '@shared/schemas';
import type { OutputFileInfo } from '@shared/schemas';
import {
  WorkspaceFS,
  flexibleFS,
  getComparablePath,
  pathToLocation,
} from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';
import { isDirectory, isFile, isSymlink } from '@utils/files/fsEntryType';

import { CHANNEL, service } from './service';
import type {
  DiffOperation,
  DiffProgressReporter,
  DiffRunOutcome,
  DiffRunResult,
} from './types';

function getFileLabel(info: OutputFileInfo): string {
  return info.source ?? path.basename(getComparablePath(info.location));
}

export async function executeDiffOperations(
  operations: DiffOperation[],
  mathMarkup: MathMarkupOption | undefined,
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
            operation.round,
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

export async function runLatexdiffFromMetadata(params: {
  rounds: Map<number, OutputFileInfo[]>;
  mathMarkup?: MathMarkupOption;
  generateBetweenRoundDiffs: boolean;
  progress: DiffProgressReporter;
}): Promise<DiffRunOutcome> {
  const { rounds, mathMarkup, generateBetweenRoundDiffs, progress } = params;

  const workspaceCwd = WorkspaceFS.getPath();
  const immediateResults: DiffRunResult[] = [];
  const operations: DiffOperation[] = [];
  const groupedByRelative = new Map<
    string,
    Array<{ round: number; info: OutputFileInfo }>
  >();

  for (const [round, infos] of rounds.entries()) {
    for (const info of infos) {
      const base = getEffectiveDiffBase(info.lineage);
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
        cwd: workspaceCwd ?? path.dirname(base.absolutePath),
        round,
      });

      const key = getComparablePath(info.location);
      const group = groupedByRelative.get(key) ?? [];
      group.push({ round, info });
      groupedByRelative.set(key, group);
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
  progress: DiffProgressReporter;
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

  const fs = platform().fs;
  const toAbsolute = (file: string): string =>
    path.isAbsolute(file) ? file : path.join(workspacePath, file);

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
    const dirEntries = await fs.readDirectory(absoluteDir);

    const roundOutputsMap = new Map<number, string>();

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
      if (!isDirectory(entryType) || isSymlink(entryType)) continue;
      const round = parseWorkflowOutputRoundDir(entryName);
      if (round == null) continue;
      if (roundOutputsMap.has(round)) continue;

      const roundAbsoluteDir = path.join(absoluteDir, entryName);
      let roundEntries: [string, number][];
      try {
        roundEntries = await fs.readDirectory(roundAbsoluteDir);
      } catch (error) {
        // Skip unreadable round dirs but record which one so a missing
        // round output isn't silently invisible during diagnosis.
        logger.debug(
          CHANNEL,
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
      const resolvedOutput = toAbsolute(roundOutputs.get(round)!);

      operations.push({
        type: 'round',
        base: pathToLocation(toAbsolute(baseFile)),
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
        const resolvedCurrent = toAbsolute(currentFile);

        operations.push({
          type: 'between-rounds',
          base: pathToLocation(resolvedCurrent),
          revised: pathToLocation(toAbsolute(nextFile)),
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
