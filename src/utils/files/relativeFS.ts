// Standard library imports
import * as path from 'node:path';

// Local imports
import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - filesystem
import { BaseFS } from './baseFS';
import { isFile } from './fsEntryType';

const log = createLog('relativeFS');

export abstract class RelativeFS extends BaseFS {
  protected static getBasePath(): string {
    throw new Error('Relative filesystem requires a base path.');
  }

  protected static override resolvePath(target: string): string {
    // If target is already absolute, return it directly.
    // path.join() incorrectly concatenates absolute paths instead of returning them.
    return path.isAbsolute(target)
      ? target
      : path.join(this.getBasePath(), target);
  }

  /**
   * Delete files older than `maxAgeMs` under `target`.
   *
   * Never throws. Callers run this housekeeping pass *after* their real work
   * has already succeeded (a completed transcription, a written pasted image),
   * so a sibling host deleting an entry between the listing and the stat, or a
   * locked file on Windows, must not destroy that result. Every failure is
   * warned with its cause instead of being swallowed, and one bad entry does
   * not stop the rest of the sweep.
   */
  public static async cleanupOldFiles(
    target: string,
    maxAgeMs: number,
  ): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    try {
      const entries = await this.readDir(target);
      await Promise.all(
        entries
          .filter(([, type]) => isFile(type))
          .map(async ([name]) => {
            const filePath = path.join(target, name);
            try {
              const stats = await this.stat(filePath);
              if (stats.mtime <= cutoff) {
                await this.delete(filePath);
              }
            } catch (error) {
              log.warn(
                `Could not remove stale file ${filePath}: ${toErrorMessage(error)}`,
              );
            }
          }),
      );
    } catch (error) {
      log.warn(`Skipped cleanup of ${target}: ${toErrorMessage(error)}`);
    }
  }
}
