// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { type ZodType } from 'zod';

// Local imports
import { parseJsonWith, safeParseJson } from '@common/parsing/safeParseJson';
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
   * Read and parse a JSON file.
   *
   * Pass a Zod `schema` to validate the parsed value — the returned `T` is
   * then guaranteed to match it. Without a schema the result is parsed but
   * cast unchecked, so prefer the schema overload for untrusted files.
   * Either way a malformed file throws a descriptive error naming the target.
   */
  public static async readJson<T>(
    target: string,
    schema?: ZodType<T>,
  ): Promise<T> {
    const raw = await this.read(target);
    const result = schema ? parseJsonWith(raw, schema) : safeParseJson(raw);
    if (result.isErr()) {
      throw new Error(
        `Failed to parse JSON from ${target}: ${result.error.message}`,
        { cause: result.error },
      );
    }
    return result.value as T;
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
