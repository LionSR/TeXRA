// Third-party imports
import * as vscode from 'vscode';
import path from 'path';

// Local imports - filesystem
import { BaseFS, type PathInput } from './baseFS';

export abstract class RelativeFS extends BaseFS {
  protected static getBaseUri(): vscode.Uri {
    throw new Error('Relative filesystem requires a base path.');
  }

  protected static override resolvePath(target: PathInput): PathInput {
    const base = this.getBaseUri();
    if (target instanceof vscode.Uri) {
      return target;
    }

    const normalized = path.normalize(target.toString());
    const segments = normalized.split(/\\|\//).filter(Boolean);

    if (path.isAbsolute(normalized)) {
      return vscode.Uri.file(normalized);
    }

    return vscode.Uri.joinPath(base, ...segments);
  }

  public static async writeJson<T>(target: PathInput, value: T): Promise<void> {
    const json = JSON.stringify(value, null, 2);
    await this.write(target, json);
  }

  public static async readJson<T>(target: PathInput): Promise<T> {
    const raw = await this.read(target);
    return JSON.parse(raw) as T;
  }

  public static async cleanupOldFiles(
    target: PathInput,
    maxAgeMs: number,
  ): Promise<void> {
    const entries = await this.readDir(target);
    const cutoff = Date.now() - maxAgeMs;

    await Promise.all(
      entries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(async ([name]) => {
          const filePath = vscode.Uri.joinPath(this.toUri(target), name);
          const stats = await this.stat(filePath);
          if (stats.mtime <= cutoff) {
            await this.delete(filePath);
          }
        }),
    );
  }
}

export default RelativeFS;
