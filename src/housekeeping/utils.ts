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

export function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 3,
): string[] {
  const patterns: string[] = [];
  const chunk = getAgentFirstNameChunk(agent);

  for (let round = 0; round < numRounds; round++) {
    const prefix = `${base}_${chunk}_r${round}`;
    patterns.push(
      `${prefix}_${model}`,
      `${prefix}_${model}_diff`,
      `${prefix}_full_${model}`,
      `${prefix}_full_${model}_diff`,
      `${prefix}_${model}_thinking`,
    );

    if (round > 0) {
      const diffSuffix = `_diffr${round}r${round - 1}`;
      patterns.push(
        `${prefix}_${model}${diffSuffix}`,
        `${prefix}_full_${model}${diffSuffix}`,
      );
    }
  }
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
