// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import { AbsoluteFS } from './absoluteFS';
import { RelativeFS } from './relativeFS';

export class WorkspaceFS extends RelativeFS {
  private static workspaceFolder: vscode.WorkspaceFolder | undefined;

  private static getWorkspaceFolder(): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Workspace path is not available.');
    }
    if (
      !this.workspaceFolder ||
      this.workspaceFolder.uri.toString() !== folder.uri.toString()
    ) {
      this.workspaceFolder = folder;
    }
    return this.workspaceFolder;
  }

  protected static override getBaseUri(): vscode.Uri {
    return this.getWorkspaceFolder().uri;
  }

  public static getPath(): string | undefined {
    return this.getUri()?.fsPath;
  }

  public static getUri(): vscode.Uri | undefined {
    return (
      this.workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri
    );
  }

  public static relativePath(filePath: vscode.Uri): string {
    return vscode.workspace.asRelativePath(filePath, false);
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
