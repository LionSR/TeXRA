// Standard library imports
import * as path from 'path';

// Third-party imports
import { sync as globSync } from 'glob';

// Local imports - log
import { parseKey } from '@agent/index';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export function getAgentFirstNameChunk(agent: string): string {
  // Extract clean agent name (strip source: prefix if present)
  // Handles all agent sources: custom, local, remote, builtIn, builtInToolUse
  const parsed = parseKey(agent);
  const cleanAgent = parsed ? parsed.name : agent;

  let result: string;
  if (cleanAgent.startsWith('write-')) {
    result = cleanAgent.split('-')[1];
  } else {
    result = cleanAgent.includes('_')
      ? cleanAgent.split('_')[0]
      : cleanAgent.split('-')[0];
  }
  return result;
}

export function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number = 3,
): string[] {
  const patterns: string[] = [];
  const agentFirstNameChunk = getAgentFirstNameChunk(agent);

  for (let round = 0; round < numRounds; round++) {
    patterns.push(
      `${base}_${agentFirstNameChunk}_r${round}_${model}`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_diff`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}`,
      `${base}_${agentFirstNameChunk}_r${round}_full_${model}_diff`,
      `${base}_${agentFirstNameChunk}_r${round}_${model}_thinking`,
    );

    // Only add diff patterns for rounds > 0 to avoid negative references
    if (round > 0) {
      patterns.push(
        `${base}_${agentFirstNameChunk}_r${round}_${model}_diffr${round}r${round - 1}`,
        `${base}_${agentFirstNameChunk}_r${round}_full_${model}_diffr${round}r${round - 1}`,
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
      const bracePattern = `${pattern}${ext}`;
      for (const dir of searchDirs) {
        const matches = globSync(path.join(dir, bracePattern), {
          nodir: true,
        });
        if (matches.length > 0) {
          results.add(WorkspaceFS.relativePath(matches[0]));
          break;
        }
      }
    }
  }

  logger.debug(CHANNEL, `Found files: ${[...results].join(', ')}`);
  return [...results];
}
