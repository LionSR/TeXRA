// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { globIterate } from 'glob';

// Local imports
import { buildBetweenRoundDiffSuffix } from '@latex/latexdiff/diffFileNameManager';
import { createLog } from '@logger/logUtils';
import {
  workflowOutputCopyStem,
  midEraWorkflowOutputStem,
} from '@shared/constants/workflowOutput';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getConfig } from '@utils/config/configUtils';

import { CHANNEL, DEFAULT_MAX_ROUNDS } from './constants';

const log = createLog(CHANNEL);

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
  numRounds: number,
): string[] {
  const patterns: string[] = [];

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
    const legacyStem = workflowOutputCopyStem({ base, agent, model, round });
    // Legacy stem already includes `_<normalizedModel>`; for suffix variants
    // we reconstruct the prefix (everything up to the model token).
    const legacyPrefix = legacyStem.slice(0, -(model.length + 1));
    patterns.push(
      legacyStem,
      `${legacyStem}_diff`,
      `${legacyPrefix}_full_${model}`,
      `${legacyPrefix}_full_${model}_diff`,
      `${legacyStem}_thinking`,
    );
    if (round > 0) {
      const diffSuffix = buildBetweenRoundDiffSuffix(round, round - 1);
      patterns.push(
        `${legacyStem}${diffSuffix}`,
        `${legacyPrefix}_full_${model}${diffSuffix}`,
      );
    }
  }
  // Legacy merge output lived next to the input and was named after the
  // edited file (`<editedBase>_full_<model>.tex`). Requiring the `_` after
  // `<base>` keeps siblings like `paper2_…` from matching when the target
  // is `paper.tex`.
  patterns.push(
    `${base}_full_${model}`,
    `${base}_full_${model}_diff`,
    `${base}_*_full_${model}`,
    `${base}_*_full_${model}_diff`,
  );
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
    log.error(
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    return null;
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  log.debug(`Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  const maxRounds = getConfig<number>('texra.agent.rounds', DEFAULT_MAX_ROUNDS);
  // Pass the raw agent; getFilePatterns derives both the legacy chunk and
  // the new clean-agent forms internally so both disk layouts are matched.
  const filePatterns = getFilePatterns(baseName, model, agent, maxRounds);
  log.debug(`Generated patterns: ${filePatterns}`);

  return { baseName, inputDir, filePatterns };
}

/**
 * Yield matching workspace files as they are discovered.
 *
 * Overlapping patterns may yield the same path more than once. Consumers that
 * retain the complete result set must deduplicate it; cleanup consumers delete
 * each yielded file before advancing, so later patterns cannot rediscover it.
 */
export async function* findFilesFromPatterns(
  inputDir: string,
  patterns: string[],
  extensions: string[],
): AsyncGenerator<string, void, void> {
  log.debug(
    `Finding files in ${inputDir} using patterns ${patterns} and extensions ${extensions}`,
  );

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return;
  }

  const searchDirs = [path.join(workspacePath, inputDir)];
  if (!inputDir.includes('build')) {
    searchDirs.push(path.join(workspacePath, inputDir, 'build'));
  }

  for (const pattern of patterns) {
    for (const ext of extensions) {
      const isGlob = ext.includes('*');
      for (const dir of searchDirs) {
        let foundExactMatch = false;
        for await (const match of globIterate(
          path.join(dir, `${pattern}${ext}`),
          { nodir: true },
        )) {
          const relativePath = WorkspaceFS.relativePath(match);
          log.debug(`Found file: ${relativePath}`);
          yield relativePath;

          if (!isGlob) {
            foundExactMatch = true;
            break;
          }
        }

        if (foundExactMatch) {
          // Exact extensions prefer the input directory; `build/` is only the
          // fallback when the corresponding root-level artifact is absent.
          break;
        }
      }
    }
  }
}

/** Collect {@link findFilesFromPatterns} matches, deduplicated. */
export async function collectFilesFromPatterns(
  inputDir: string,
  patterns: string[],
  extensions: string[],
): Promise<Set<string>> {
  const files = new Set<string>();
  for await (const file of findFilesFromPatterns(
    inputDir,
    patterns,
    extensions,
  )) {
    files.add(file);
  }
  return files;
}
