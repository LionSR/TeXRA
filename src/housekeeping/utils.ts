// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { sync as globSync } from 'glob';

// Local imports
import { buildBetweenRoundDiffSuffix } from '@latex/latexdiff/diffFileNameManager';
import * as logger from '@logger/logUtils';
import {
  legacyWorkflowOutputStem,
  midEraWorkflowOutputStem,
  normalizeLegacyModel,
} from '@shared/constants/legacyWorkflowOutput';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

import { DEFAULT_MAX_ROUNDS } from './constants';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

/**
 * Produce an ISO-8601 timestamp stripped of separators, suitable for use in
 * a file or folder name (e.g. `20260422T003541`). Second-level granularity.
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0];
}

/**
 * Build glob patterns that match pre-refactor workflow output filenames
 * left over in the user's workspace. Current-layout outputs live inside
 * task-run storage (`executions/{id}/…`) and are managed per-execution, so
 * they are not scanned for here.
 *
 * Pass the raw agent identifier (with any source prefix) — the SSOT
 * helpers derive the legacy chunk form internally so the result matches
 * what pre-refactor runs wrote to disk.
 */
function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 3,
): string[] {
  const patterns: string[] = [];
  const legacyModel = normalizeLegacyModel(model);

  // Mid-era layout: files live under `r{round}/<base>_<cleanAgent>_<model>.*`.
  // These files can still be present in workspaces for users who upgraded
  // from the mid-era PR; without matching patterns here, clean/pack would
  // leave them orphaned.
  const midEraStem = midEraWorkflowOutputStem({ base, agent, model });
  for (let round = 0; round < numRounds; round++) {
    patterns.push(
      `r${round}/${midEraStem}`,
      `r${round}/${midEraStem}_diff`,
      `r${round}/${midEraStem}_thinking`,
    );
    if (round > 0) {
      patterns.push(
        `r${round}/${midEraStem}${buildBetweenRoundDiffSuffix(round, round - 1)}`,
      );
    }
  }

  for (let round = 0; round < numRounds; round++) {
    // Legacy flat layout: `<base>_<chunk>_r{round}_<normalizedModel>.*`
    const legacyStem = legacyWorkflowOutputStem({ base, agent, model, round });
    // Legacy stem already includes `_<normalizedModel>`; for suffix variants
    // we reconstruct the prefix (everything up to the model token).
    const legacyPrefix = legacyStem.slice(0, -(legacyModel.length + 1));
    patterns.push(
      legacyStem,
      `${legacyStem}_diff`,
      `${legacyPrefix}_full_${legacyModel}`,
      `${legacyPrefix}_full_${legacyModel}_diff`,
      `${legacyStem}_thinking`,
    );
    if (round > 0) {
      const diffSuffix = buildBetweenRoundDiffSuffix(round, round - 1);
      patterns.push(
        `${legacyStem}${diffSuffix}`,
        `${legacyPrefix}_full_${legacyModel}${diffSuffix}`,
      );
    }
  }
  // Legacy merge output lived next to the input and was named after the
  // edited file (`<editedBase>_full_<model>.tex`). Requiring the `_` after
  // `<base>` keeps siblings like `paper2_…` from matching when the target
  // is `paper.tex`. Emit both raw and normalized-model variants so legacy
  // merge files written with the dot-stripped model token
  // (`paper_full_gpt45`) are discovered alongside current-legacy files
  // (`paper_full_gpt-4.5`).
  const mergeModels = legacyModel === model ? [model] : [model, legacyModel];
  for (const m of mergeModels) {
    patterns.push(
      `${base}_full_${m}`,
      `${base}_full_${m}_diff`,
      `${base}_*_full_${m}`,
      `${base}_*_full_${m}_diff`,
    );
  }
  return patterns;
}

export interface HousekeepingTargets {
  baseName: string;
  inputDir: string;
  filePatterns: string[];
}

/**
 * Validates the parameters shared by clean and pack operations, then derives
 * the parsed input path parts and round-aware file patterns for the agent's
 * output layouts. Returns null (after logging) when a parameter is missing.
 */
export function resolveHousekeepingTargets(
  model: string,
  inputFile: string,
  agent: string,
): HousekeepingTargets | null {
  if (!inputFile || !model || !agent) {
    logger.error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    return null;
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  logger.debug(
    CHANNEL,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const maxRounds = getConfig<number>('texra.agent.rounds', DEFAULT_MAX_ROUNDS);
  // Pass the raw agent; getFilePatterns derives both the legacy chunk and
  // the new clean-agent forms internally so both disk layouts are matched.
  const filePatterns = getFilePatterns(baseName, model, agent, maxRounds);
  logger.debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  return { baseName, inputDir, filePatterns };
}

export function findFilesFromPatterns(
  inputDir: string,
  patterns: string[],
  extensions: string[],
): string[] {
  logger.debug(
    CHANNEL,
    `Finding files in ${inputDir} using patterns ${patterns} and extensions ${extensions}`,
  );

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return [];
  }

  const searchDirs = [path.join(workspacePath, inputDir)];
  if (!inputDir.includes('build')) {
    searchDirs.push(path.join(workspacePath, inputDir, 'build'));
  }

  const results = new Set<string>();

  for (const pattern of patterns) {
    for (const ext of extensions) {
      const isGlob = ext.includes('*');
      for (const dir of searchDirs) {
        const matches = globSync(path.join(dir, `${pattern}${ext}`), {
          nodir: true,
        });
        if (matches.length === 0) continue;

        if (isGlob) {
          for (const match of matches) {
            results.add(WorkspaceFS.relativePath(match));
          }
        } else {
          results.add(WorkspaceFS.relativePath(matches[0]));
          break;
        }
      }
    }
  }

  const found = [...results];
  logger.debug(CHANNEL, `Found files: ${found.join(', ')}`);
  return found;
}
