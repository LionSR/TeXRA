// Standard library imports
import * as path from 'path';

// Third-party imports
import { sync as globSync } from 'glob';

// Local imports - log
import { getCleanAgentName } from '@agent/index';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

/**
 * Parse a directory name of the form `r{round}` into its round index.
 * Returns null if the name doesn't match the round-folder convention used
 * by the new workflow output layout.
 */
export function parseRoundFolder(dirName: string): number | null {
  const match = /^r(\d+)$/.exec(dirName);
  return match ? Number(match[1]) : null;
}

export function getAgentFirstNameChunk(agent: string): string {
  const cleanAgent = getCleanAgentName(agent);

  if (cleanAgent.startsWith('write-')) {
    return cleanAgent.split('-')[1];
  }
  if (cleanAgent.includes('_')) {
    return cleanAgent.split('_')[0];
  }
  return cleanAgent.split('-')[0];
}

/**
 * Build glob patterns that match workflow output filenames in both layouts.
 *
 * Pass the raw agent identifier (with any source prefix) — this function
 * derives both the legacy "first-name chunk" and the new "clean agent" forms
 * internally so the result includes patterns that match what
 * `getOutputFileName` writes today and what older runs left on disk.
 */
export function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 3,
): string[] {
  const patterns: string[] = [];
  const chunk = getAgentFirstNameChunk(agent);
  const cleanAgent = getCleanAgentName(agent);

  for (let round = 0; round < numRounds; round++) {
    // Legacy flat layout: `<base>_<chunk>_r{round}_<model>.*`
    const legacyPrefix = `${base}_${chunk}_r${round}`;
    patterns.push(
      `${legacyPrefix}_${model}`,
      `${legacyPrefix}_${model}_diff`,
      `${legacyPrefix}_full_${model}`,
      `${legacyPrefix}_full_${model}_diff`,
      `${legacyPrefix}_${model}_thinking`,
    );
    if (round > 0) {
      const diffSuffix = `_diffr${round}r${round - 1}`;
      patterns.push(
        `${legacyPrefix}_${model}${diffSuffix}`,
        `${legacyPrefix}_full_${model}${diffSuffix}`,
      );
    }

    // New round-subfolder layout:
    //   `r{round}/<base>_<cleanAgent>_<model>.*`
    // Agent is the clean name (source prefixes stripped) — not the
    // first-name chunk — so it matches what getOutputFileName produces.
    const newPrefix = `r${round}/${base}_${cleanAgent}`;
    patterns.push(
      `${newPrefix}_${model}`,
      `${newPrefix}_${model}_diff`,
      `${newPrefix}_${model}_thinking`,
    );
    if (round > 0) {
      const diffSuffix = `_diffr${round}r${round - 1}`;
      patterns.push(`${newPrefix}_${model}${diffSuffix}`);
    }
  }
  // Merge output lives next to the input and is named after the edited
  // file (`<editedBase>_full_<model>.tex`). editedBase typically starts
  // with the input base (merges usually feed on a prior output of the
  // same input), so a leading-wildcard glob matches both the simple
  // `<base>_full_<model>` case and the full `<base>_<…>_full_<model>`
  // case without knowing editedBase ahead of time.
  patterns.push(`${base}*_full_${model}`, `${base}*_full_${model}_diff`);
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
