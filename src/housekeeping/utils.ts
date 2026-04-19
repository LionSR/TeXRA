// Standard library imports
import * as path from 'path';

// Third-party imports
import { sync as globSync } from 'glob';

// Local imports - log
import {
  getAgentFirstNameChunk,
  legacyWorkflowOutputStem,
  normalizeLegacyModel,
  parseWorkflowOutputRoundDir,
  workflowMergeFilenameStem,
  workflowOutputGlobPrefix,
} from '@agent/output/workflowOutputLayout';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export { getAgentFirstNameChunk };

/** @deprecated Re-exported for backward compatibility; prefer the SSOT helper. */
export const parseRoundFolder = parseWorkflowOutputRoundDir;

/**
 * Build glob patterns that match workflow output filenames in both layouts.
 *
 * Pass the raw agent identifier (with any source prefix) — the SSOT
 * helpers derive the clean agent / legacy chunk forms internally so the
 * result matches what `getOutputFileName` writes today and what older
 * runs left on disk.
 */
export function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 3,
): string[] {
  const patterns: string[] = [];
  const legacyModel = normalizeLegacyModel(model);

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
      const diffSuffix = `_diffr${round}r${round - 1}`;
      patterns.push(
        `${legacyStem}${diffSuffix}`,
        `${legacyPrefix}_full_${legacyModel}${diffSuffix}`,
      );
    }

    // New round-subfolder layout:
    //   `r{round}/<base>_<cleanAgent>_<model>.*`
    const newPrefix = workflowOutputGlobPrefix({ base, agent, model, round });
    patterns.push(
      newPrefix,
      `${newPrefix}_diff`,
      `${newPrefix}_thinking`,
    );
    if (round > 0) {
      const diffSuffix = `_diffr${round}r${round - 1}`;
      patterns.push(`${newPrefix}${diffSuffix}`);
    }
  }
  // Merge output lives next to the input and is named after the edited
  // file (`<editedBase>_full_<model>.tex`). editedBase typically starts
  // with the input base plus an agent/model suffix, so we emit two
  // delimiter-aware patterns: the simple `<base>_full_<model>` case and
  // the `<base>_<…>_full_<model>` case. Requiring the `_` after `<base>`
  // keeps siblings like `paper2_…` from matching when the target is
  // `paper.tex`.
  const simpleMerge = workflowMergeFilenameStem(base, model);
  patterns.push(
    simpleMerge,
    `${simpleMerge}_diff`,
    `${base}_*_full_${model}`,
    `${base}_*_full_${model}_diff`,
  );
  return patterns;
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
