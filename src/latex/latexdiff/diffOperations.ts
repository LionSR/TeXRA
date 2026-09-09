/**
 * Build and execute latexdiff operations from either run metadata
 * (`OutputFileInfo` per round) or a workspace scan of legacy/mid-era layouts.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { MathMarkupOption } from '@latex/latexdiff/mathMarkup';
import { createLog } from '@logger/logUtils';
import {
  getEffectiveDiffBase,
  roundIndexedEntries,
  RoundKeySchema,
} from '@shared/schemas';
import type { OutputFileInfo, ReadonlyRoundIndexed } from '@shared/schemas';
import {
  legacyWorkflowOutputRoundRegex,
  midEraWorkflowOutputStem,
  parseWorkflowOutputRoundDir,
} from '@shared/constants/workflowOutput';
import { getSafeDocumentRelativePath } from '@utils/files/outputFileUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { ensureError } from '@utils/errors/errorMessage';
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

const executeDiffOperations = Effect.fn('latexdiff.executeDiffOperations')(
  function* (
    operations: readonly DiffOperation[],
    mathMarkup: MathMarkupOption | undefined,
    latexdiff: LatexdiffRuntime,
    progress: DiffProgressReporter,
    immediateResults: DiffRunResult[] = [],
  ): Effect.fn.Return<DiffRunOutcome, Error> {
    const results: DiffRunResult[] = [...immediateResults];
    // Zero operations never enter the loop, so the bare division is safe.
    const incrementPct = 100 / operations.length;
    const log = createLog(latexdiff.channel);

    // Sequential by design: each latexdiff is a whole TeX run, and the
    // progress reporter narrates them one at a time.
    for (const operation of operations) {
      progress.report({
        increment: incrementPct,
        message: `Running ${operation.type} diff for ${operation.description}`,
      });

      const [baseExists, revisedExists] = yield* Effect.all(
        [
          exists(operation.base.absolutePath),
          exists(operation.revised.absolutePath),
        ],
        { concurrency: 2 },
      );

      if (!baseExists || !revisedExists) {
        results.push({
          success: false,
          message: 'Required files are missing on disk',
          description: operation.description,
        });
        continue;
      }

      log.debug(`Running ${operation.type} diff: ${operation.description}`);

      const diffResult =
        operation.type === 'round'
          ? yield* latexdiff.service.runDiffForRound(
              operation.base,
              operation.revised,
              operation.round,
              mathMarkup,
              { cwd: operation.cwd },
            )
          : yield* latexdiff.service.runDiffBetweenRounds(
              operation.base,
              operation.revised,
              operation.fromRound,
              operation.toRound,
              mathMarkup,
              { cwd: operation.cwd },
            );

      results.push({ ...diffResult, description: operation.description });
    }

    return { results };
  },
);

const exists = (absolutePath: string): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: () => AbsoluteFS.exists(absolutePath),
    catch: ensureError,
  });

const readDir = (
  absolutePath: string,
): Effect.Effect<[string, number][], Error> =>
  Effect.tryPromise({
    try: () => AbsoluteFS.readDir(absolutePath),
    catch: ensureError,
  });

export const runLatexdiffFromMetadata = Effect.fn('latexdiff.runFromMetadata')(
  function* (params: {
    rounds: ReadonlyRoundIndexed<OutputFileInfo>;
    mathMarkup?: MathMarkupOption;
    generateBetweenRoundDiffs: boolean;
    latexdiff: LatexdiffRuntime;
    progress: DiffProgressReporter;
  }): Effect.fn.Return<DiffRunOutcome, Error> {
    const {
      rounds,
      mathMarkup,
      generateBetweenRoundDiffs,
      latexdiff,
      progress,
    } = params;

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
        const source = getSafeDocumentRelativePath(info.source);
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
          const description = `${getSafeDocumentRelativePath(current.info.source)} (r${previous.round}→r${current.round})`;

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

    return yield* executeDiffOperations(
      operations,
      mathMarkup,
      latexdiff,
      progress,
      immediateResults,
    );
  },
);

export const runLatexdiffViaWorkspaceScan = Effect.fn(
  'latexdiff.runViaWorkspaceScan',
)(function* (params: {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  mathMarkup?: MathMarkupOption;
  generateBetweenRoundDiffs: boolean;
  latexdiff: LatexdiffRuntime;
  progress: DiffProgressReporter;
}): Effect.fn.Return<DiffRunOutcome, Error> {
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
  const log = createLog(latexdiff.channel);

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return yield* Effect.fail(new Error('No workspace path found'));
  }

  const toAbsolute = (file: string): string =>
    path.isAbsolute(file) ? file : path.join(workspacePath, file);

  const configuredInputFiles =
    outputFiles && outputFiles.length > 0 ? outputFiles : [inputFile];

  log.debug(`Input files: ${configuredInputFiles.join(', ')}`);

  // Per input file: round number → workspace-relative output path. A round
  // matched more than once (e.g. two legacy files matching the same round
  // regex) keeps a single entry, last match wins.
  const inputToOutputsMap = new Map<
    string,
    Array<{ round: number; outputPath: string }>
  >();

  for (const candidateInput of configuredInputFiles) {
    const outputDirPath = path.dirname(candidateInput);
    const baseInputName = path.basename(
      candidateInput,
      path.extname(candidateInput),
    );

    const absoluteDir = path.join(workspacePath, outputDirPath);
    const dirEntries = yield* readDir(absoluteDir);

    const roundOutputs = new Map<number, string>();

    // Legacy flat layout: files sit directly under outputDirPath as
    // `<base>_<chunk>_r{round}_<model>.tex`.
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
      // Skip unreadable round dirs but record which one so a missing round
      // output isn't silently invisible during diagnosis.
      const roundEntries = yield* readDir(roundAbsoluteDir).pipe(
        Effect.catch((error) =>
          Effect.sync((): [string, number][] | null => {
            log.debug(`Skipping round dir '${roundAbsoluteDir}': ${error}`);
            return null;
          }),
        ),
      );
      if (roundEntries === null) continue;
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
      inputToOutputsMap.set(
        candidateInput,
        [...roundOutputs].map(([round, outputPath]) => ({ round, outputPath })),
      );
      log.debug(
        `Found ${roundOutputs.size} matching outputs for ${candidateInput}`,
      );
    } else {
      log.debug(`No matching outputs found for ${candidateInput}`);
    }
  }

  if (inputToOutputsMap.size === 0) {
    return { results: [] };
  }

  const operations: DiffOperation[] = [];

  for (const [baseFile, roundOutputs] of inputToOutputsMap.entries()) {
    const sorted = roundOutputs.toSorted((a, b) => a.round - b.round);

    for (const { round, outputPath } of sorted) {
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
      for (const [index, current] of sorted.slice(1).entries()) {
        const previous = sorted[index];
        const resolvedPrevious = toAbsolute(previous.outputPath);

        operations.push({
          type: 'between-rounds',
          base: pathToLocation(resolvedPrevious),
          revised: pathToLocation(toAbsolute(current.outputPath)),
          description: `${path.basename(previous.outputPath)} (r${previous.round}→r${current.round})`,
          cwd: path.dirname(resolvedPrevious),
          fromRound: previous.round,
          toRound: current.round,
        });
      }
    }
  }

  return yield* executeDiffOperations(
    operations,
    mathMarkup,
    latexdiff,
    progress,
  );
});
