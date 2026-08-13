// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { type ZodType } from 'zod';

// Local imports
import { parseJsonWith, safeParseJson } from '@common/parsing/safeParseJson';

// Local imports - filesystem
import { isFile } from './fsEntryType';
import { BaseFS } from './baseFS';

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

  public static async cleanupOldFiles(
    target: string,
    maxAgeMs: number,
  ): Promise<void> {
    const entries = await this.readDir(target);
    const cutoff = Date.now() - maxAgeMs;

    await Promise.all(
      entries
        .filter(([, type]) => isFile(type))
        .map(async ([name]) => {
          const filePath = path.join(target, name);
          const stats = await this.stat(filePath);
          if (stats.mtime <= cutoff) {
            await this.delete(filePath);
          }
        }),
    );
  }
}
