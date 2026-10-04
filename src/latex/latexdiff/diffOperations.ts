/**
 * Host-neutral orchestration for a full latexdiff run.
 *
 * Reads the run's recorded round outputs from the session's fold (the
 * `output.produced` facts, via {@link LatexRunDiscoveryPort.readRunOutputs}),
 * builds one diff operation per round output (and, when the workspace's
 * between-rounds setting is on, one per consecutive pair of rounds), and runs
 * them. That fold is the only source: run storage is never rescanned and no
 * workspace filename is parsed, so a run with no recorded outputs has no diff
 * operations. This is the single source of truth shared by every host (VS Code
 * command, desktop); each host keeps only its own UX (progress chrome,
 * prompts, result rendering) and calls this with a {@link DiffProgressReporter}.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, type FileSystem, type Path } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { LatexdiffMathMarkupValue } from '@shared/constants/latexConfig';
import {
  getEffectiveDiffBase,
  roundIndexedEntries,
  type FileLocation,
  type OutputFileInfo,
  type RunId,
} from '@shared/schemas';
import { TexraStateKey } from '@shared/settingsView/texraSettings';
import { readSettingFrom } from '@utils/config/platformSettings';
import { getSafeDocumentRelativePath } from '@utils/files/outputFileUtils';

// Local file imports
import { LaTeXdiffService } from '../latexdiff';
import { buildBetweenRoundDiffSuffix } from './diffFileNameManager';
import type { LatexRunDiscoveryPort } from './runDiscovery';
import type {
  DiffProgressReporter,
  DiffRunOutcome,
  DiffRunResult,
} from './types';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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
    /**
     * The calling session's roots: the between-rounds setting is read from
     * them, the diff service is bound to them, and their workspace folder is
     * the cwd every diff operation runs in (a diff falls back to its base
     * file's folder when no folder is open).
     */
    readonly roots: WorkspaceRoots;
    /** Agent-owned read of the run's recorded outputs, injected by hosts. */
    readonly runDiscovery: LatexRunDiscoveryPort;
    readonly mathMarkup?: LatexdiffMathMarkupValue;
    /** Logger channel the diff run reports under (host-specific). */
    readonly channel: string;
    readonly progress: DiffProgressReporter;
  }): Effect.fn.Return<
    DiffRunOutcome,
    Error,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  > {
    const { runId, roots, mathMarkup, progress } = params;
    const rounds = yield* params.runDiscovery.readRunOutputs(runId);

    // Hosts report an empty outcome as "no diff operations for this run".
    if (!Object.values(rounds).some((files) => files.length > 0)) {
      yield* Effect.logWarning(
        `No recorded outputs for run ${runId}; nothing to diff`,
      );
      return { results: [] };
    }

    const generateBetweenRoundDiffs = yield* readSettingFrom<boolean>(
      roots,
      TexraStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    );
    yield* Effect.logDebug(`Between rounds: ${generateBetweenRoundDiffs}`);

    const results: DiffRunResult[] = [];
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
          results.push({
            success: false,
            message: 'Missing base file path',
            description,
          });
          continue;
        }

        operations.push({
          base,
          revised: info.location,
          description,
          cwd: roots.workspace ?? path.dirname(base.absolutePath),
          suffix: '_diff',
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

          operations.push({
            base,
            revised: current.info.location,
            description: `${getSafeDocumentRelativePath(current.info.source)} (r${previous.round}→r${current.round})`,
            cwd: roots.workspace ?? path.dirname(base.absolutePath),
            suffix: buildBetweenRoundDiffSuffix(current.round, previous.round),
          });
        }
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
