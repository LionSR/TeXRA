// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
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

  public static override fullPath(target: string): string {
    return super.fullPath(target);
  }

  public static async writeJson<T>(target: string, value: T): Promise<void> {
    const json = JSON.stringify(value, null, 2);
    await this.write(target, json);
  }

  public static async readJson<T>(target: string): Promise<T> {
    const raw = await this.read(target);
    return JSON.parse(raw) as T;
  }

  public static async cleanupOldFiles(
    target: string,
    maxAgeMs: number,
  ): Promise<void> {
    const entries = await this.readDir(target);
    const cutoff = Date.now() - maxAgeMs;

    await Promise.all(
      entries
        .filter(([, type]) => type === vscode.FileType.File)
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

export default RelativeFS;
