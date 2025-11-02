// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { AbsoluteFS } from './absoluteFS';
import { RelativeFS } from './relativeFS';

export class WorkspaceFS extends RelativeFS {
  protected static override getBasePath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No workspace path found');
    }
    return workspaceFolders[0].uri.fsPath;
  }

  public static getPath(): string | undefined {
    try {
      return this.getBasePath();
    } catch {
      return undefined;
    }
  }

  public static relativePath(filePath: string): string {
    const workspacePath = this.getPath();
    return workspacePath ? path.relative(workspacePath, filePath) : filePath;
  }

  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    try {
      await super.delete(relativePath, options);
    } catch (err) {
      if (
        err instanceof vscode.FileSystemError &&
        err.code === 'FileNotFound'
      ) {
        return;
      }
      throw err;
    }
  }

  public static async appendFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    const existing = (await this.exists(filePath))
      ? await this.read(filePath)
      : '';
    await this.write(filePath, existing + content);
  }

  public static async existsAndNonTrivial(filePath: string): Promise<boolean> {
    return (
      (await this.exists(filePath)) && (await this.read(filePath)).length > 15
    );
  }

  public static async readFileBytes(filePath: string): Promise<Buffer> {
    const fullPath = this.fullPath(filePath);
    return AbsoluteFS.readBytes(fullPath);
  }

  public static readFileBytesSync(filePath: string): Buffer {
    const fullPath = this.fullPath(filePath);
    return AbsoluteFS.readBytesSync(fullPath);
  }

  public static async filterExistingFiles<T extends { path: string }>(
    items: T[],
  ): Promise<T[]> {
    if (!items || items.length === 0) {
      return [];
    }

    const results = await Promise.all(
      items.map(async (item) => ({
        item,
        exists: await this.exists(item.path),
      })),
    );

    return results.filter((result) => result.exists).map((result) => result.item);
  }
}

export default WorkspaceFS;
