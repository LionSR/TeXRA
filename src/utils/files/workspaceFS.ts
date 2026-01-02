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

  /**
   * Convert an absolute path to a workspace-relative path.
   * Uses VS Code's asRelativePath which properly handles symlinks.
   * Returns the original path if no workspace is open.
   */
  public static relativePath(filePath: string): string {
    if (!this.getPath()) {
      return filePath;
    }
    return vscode.workspace.asRelativePath(filePath, false);
  }

  public static async existsAndNonTrivial(target: string): Promise<boolean> {
    return (await this.exists(target)) && (await this.read(target)).length > 15;
  }

  public static async readFileBytes(target: string): Promise<Buffer> {
    return AbsoluteFS.readBytes(this.fullPath(target));
  }

  /**
   * Convert a file path to an absolute path.
   * If already absolute, returns unchanged. Otherwise resolves relative to workspace.
   */
  public static toAbsolute(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : this.fullPath(filePath);
  }
}

/** @deprecated Use WorkspaceFS.toAbsolute() instead */
export const resolveFilePath = (filePath: string): string =>
  WorkspaceFS.toAbsolute(filePath);

export default WorkspaceFS;
