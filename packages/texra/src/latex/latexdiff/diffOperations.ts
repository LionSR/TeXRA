/**
 * Host-neutral orchestration for a full latexdiff run, and the one pairing
 * every latexdiff of a document task's outputs follows ({@link latexdiffPairs}),
 * which the run's own `document_diff` shares.
 *
 * Takes the run's recorded round outputs (its documents, as the host's view
 * of the session folds them), builds one diff operation per pair each round's
 * outputs call for, and runs them. That fold is the only source: run storage
 * is never rescanned and no workspace filename is parsed, so a run with no
 * recorded outputs has no diff operations. Every host (VS Code command,
 * desktop) keeps only its own UX (progress chrome, prompts, result rendering)
 * and calls this with a {@link DiffProgressReporter}.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, type FileSystem, type Path } from 'effect';

// Local imports
import { withLogChannel, Settings } from '@texra-ai/harness';
import type { LatexdiffMathMarkupValue } from '@texra/shared/constants/latexConfig';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { getSafeDocumentRelativePath } from '@texra/utils/files/outputFileUtils';
import {
  getEffectiveDiffBase,
  roundIndexedEntries,
  type ReadonlyRoundIndexed,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';

// Local file imports
import { LaTeXdiffService } from '../latexdiff';
import { buildBetweenRoundDiffSuffix } from './diffFileNameManager';
import type { FileLocation, RunId } from '@texra-ai/harness/schemas';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type {
  DiffProgressReporter,
  DiffRunOutcome,
  DiffRunResult,
} from './types';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** One latexdiff a round's recorded outputs call for. */
export interface LatexdiffPair {
  /** The round's output the diff marks up. */
  readonly revised: OutputFileInfo;
  /** What it is diffed against. */
  readonly base: FileLocation;
  /** The round `base` came from; null for the document the task started
   *  from. */
  readonly baseRound: number | null;
}

/**
 * The latexdiffs a round's recorded `outputs` call for: each output against
 * the document it started from (its recorded lineage's diff base), then each
 * against its own output in the `previous` round (empty when between-round
 * diffs are off). An output's document is its source as the round wrote it
 * (`getSafeDocumentRelativePath`), never its basename: `a/main.tex` and
 * `b/main.tex` are two documents.
 */
export function latexdiffPairs(
  outputs: readonly OutputFileInfo[],
  previous: readonly OutputFileInfo[],
): LatexdiffPair[] {
  const fromBase = outputs.flatMap((revised): LatexdiffPair[] => {
    const base = getEffectiveDiffBase(revised.lineage);
    return base ? [{ revised, base, baseRound: null }] : [];
  });
  const previousByDocument = new Map(
    previous.map((info) => [getSafeDocumentRelativePath(info.source), info]),
  );
  const fromPrevious = outputs.flatMap((revised): LatexdiffPair[] => {
    const prior = previousByDocument.get(
      getSafeDocumentRelativePath(revised.source),
    );
    return prior
      ? [{ revised, base: prior.location, baseRound: prior.round }]
      : [];
  });
  return [...fromBase, ...fromPrevious];
}

/** One latexdiff call: `suffix` names the diff file it writes. */
interface DiffOperation {
  base: FileLocation;
  revised: FileLocation;
  description: string;
  cwd: string;
  suffix: string;
}

export const runLatexdiffForRun = Effect.fn('runLatexdiffForRun')(
  function* (params: {
    /** The run whose recorded outputs are diffed. */
    readonly runId: RunId;
    /** The run's recorded output files by round (`runOutputFiles`). */
    readonly rounds: ReadonlyRoundIndexed<OutputFileInfo>;
    /**
     * The calling session's roots: the between-rounds setting is read from
     * them, the diff service is bound to them, and their workspace folder is
     * the cwd every diff operation runs in (a diff falls back to its base
     * file's folder when no folder is open).
     */
    readonly roots: WorkspaceRoots;
    readonly mathMarkup?: LatexdiffMathMarkupValue;
    /** Logger channel the diff run reports under (host-specific). */
    readonly channel: string;
    readonly progress: DiffProgressReporter;
  }): Effect.fn.Return<
    DiffRunOutcome,
    Error,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  > {
    const { runId, rounds, roots, mathMarkup, progress } = params;

    // Hosts report an empty outcome as "no diff operations for this run".
    if (!Object.values(rounds).some((files) => files.length > 0)) {
      yield* Effect.logWarning(
        `No recorded outputs for run ${runId}; nothing to diff`,
      );
      return { results: [] };
    }

    const generateBetweenRoundDiffs = yield* Settings.get<boolean>(
      roots,
      DocumentsStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    );
    yield* Effect.logDebug(`Between rounds: ${generateBetweenRoundDiffs}`);

    const results: DiffRunResult[] = [];
    const operations: DiffOperation[] = [];

    for (const [round, infos] of roundIndexedEntries(rounds)) {
      for (const info of infos) {
        if (getEffectiveDiffBase(info.lineage)) continue;
        results.push({
          success: false,
          message: 'Missing base file path',
          description: `${getSafeDocumentRelativePath(info.source)} (r${round})`,
        });
      }
      const previous = generateBetweenRoundDiffs
        ? (rounds[round - 1] ?? [])
        : [];
      for (const { revised, base, baseRound } of latexdiffPairs(
        infos,
        previous,
      )) {
        const source = getSafeDocumentRelativePath(revised.source);
        operations.push({
          base,
          revised: revised.location,
          description:
            baseRound === null
              ? `${source} (r${round})`
              : `${source} (r${baseRound}→r${round})`,
          cwd: roots.workspace ?? path.dirname(base.absolutePath),
          suffix:
            baseRound === null
              ? '_diff'
              : buildBetweenRoundDiffSuffix(round, baseRound),
        });
      }
    }

    const service = new LaTeXdiffService(params.channel, roots);
    // Zero operations never enter the loop, so the bare division is safe.
    const incrementPct = 100 / operations.length;

    // Sequential by design: each latexdiff is a whole TeX run, and the
    // progress reporter narrates them one at a time.
    for (const operation of operations) {
      progress.report({
        increment: incrementPct,
        message: `Running diff for ${operation.description}`,
      });

      const diffResult = yield* service.runDiff(
        operation.base,
        operation.revised,
        operation.suffix,
        mathMarkup,
        { cwd: operation.cwd },
      );

      results.push({ ...diffResult, description: operation.description });
    }

    return { results };
  },
  // One channel for the whole run, so the read and the diff engine below
  // both land on the caller's channel.
  (effect, params) => withLogChannel(params.channel)(effect),
);
