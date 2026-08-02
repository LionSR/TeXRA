// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { globIterate } from 'glob';

// Local imports
import * as logger from '@logger/logUtils';
import { legacyWorkflowOutputStem } from '@shared/constants/workflowOutput';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

import { CHANNEL, DEFAULT_MAX_ROUNDS } from './constants';

/**
 * Produce an ISO-8601 timestamp stripped of separators, suitable for use in
 * a file or folder name (e.g. `20260422T003541`). Second-level granularity.
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0];
}

/**
 * Build glob patterns for flat copies saved beside the source document.
 * Current workflow outputs live in execution storage; the extension's
 * "Save as copy" action is the sole writer of this workspace filename.
 */
function getFilePatterns(
  base: string,
  model: string,
  agent: string,
  numRounds: number,
): string[] {
  const patterns: string[] = [];

  for (let round = 0; round < numRounds; round++) {
    patterns.push(legacyWorkflowOutputStem({ base, agent, model, round }));
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
  const filePatterns = getFilePatterns(baseName, model, agent, maxRounds);
  logger.debug(CHANNEL, `Generated patterns: ${filePatterns}`);

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
  logger.debug(
    CHANNEL,
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
          logger.debug(CHANNEL, `Found file: ${relativePath}`);
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
