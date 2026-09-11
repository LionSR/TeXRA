// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { globIterate } from 'glob';

// Local imports
import { createLog } from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { CHANNEL } from './constants';

const log = createLog(CHANNEL);

/**
 * Produce an ISO-8601 timestamp stripped of separators, suitable for use in
 * a file or folder name (e.g. `20260422T003541`). Second-level granularity.
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0];
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

  // `resolve`, not `join`: an inputDir that is already absolute names the
  // directory it says, while a workspace-relative one is taken from the
  // workspace root. Joining an absolute path onto the root duplicated the
  // prefix and found nothing.
  const searchDirs = [path.resolve(workspacePath, inputDir)];
  if (!inputDir.includes('build')) {
    searchDirs.push(path.resolve(workspacePath, inputDir, 'build'));
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
