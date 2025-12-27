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

  public static async existsAndNonTrivial(target: string): Promise<boolean> {
    return (await this.exists(target)) && (await this.read(target)).length > 15;
  }

  public static async readFileBytes(target: string): Promise<Buffer> {
    return AbsoluteFS.readBytes(this.fullPath(target));
  }
}

export default WorkspaceFS;
