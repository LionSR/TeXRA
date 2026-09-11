/**
 * Build and execute latexdiff operations from run metadata
 * (`OutputFileInfo` per round).
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { MathMarkupOption } from '@latex/latexdiff/mathMarkup';
import { withLogChannel } from '@logger/effectLog';
import { getEffectiveDiffBase, roundIndexedEntries } from '@shared/schemas';
import type { OutputFileInfo, ReadonlyRoundIndexed } from '@shared/schemas';
import { getSafeDocumentRelativePath } from '@utils/files/outputFileUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { ensureError } from '@utils/errors/errorMessage';
import { WorkspaceFS } from '@utils/files/workspaceFS';

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

      yield* Effect.logDebug(
        `Running ${operation.type} diff: ${operation.description}`,
      );

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
  // One channel for the whole run, named once here instead of threaded
  // through each helper below.
  (effect, params) => withLogChannel(params.latexdiff.channel)(effect),
);
