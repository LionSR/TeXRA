// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import { AbsoluteFS } from './absoluteFS';
import { RelativeFS } from './relativeFS';

export class WorkspaceFS extends RelativeFS {
  protected static override getBasePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Workspace path is not available.');
    }
    return folder.uri.fsPath;
  }

  public static getPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  public static relativePath(filePath: string): string {
    const base = this.getPath();
    return base ? path.relative(base, filePath) : filePath;
  }

  public static async appendFile(
    target: string,
    content: string,
  ): Promise<void> {
    const existing = (await this.exists(target)) ? await this.read(target) : '';
    await this.write(target, `${existing}${content}`);
  }

  public static async existsAndNonTrivial(target: string): Promise<boolean> {
    return (await this.exists(target)) && (await this.read(target)).length > 15;
  }

  public static async readFileBytes(target: string): Promise<Buffer> {
    return AbsoluteFS.readBytes(this.fullPath(target));
  }

  public static readFileBytesSync(target: string): Buffer {
    return AbsoluteFS.readBytesSync(this.fullPath(target));
  }

  public static async filterExistingFiles<T extends { path: string }>(
    items: T[],
  ): Promise<T[]> {
    if (items.length === 0) {
      return [];
    }

    const checks = await Promise.all(
      items.map(async (item) => ({
        item,
        exists: await this.exists(item.path),
      })),
    );
    return checks.filter((entry) => entry.exists).map((entry) => entry.item);
  }
}

export default WorkspaceFS;
