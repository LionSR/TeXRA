// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { ensureDirCommon } from './ensureDirCommon';

/**
 * Minimal filesystem helper backed by a configurable base path.
 * Subclasses only need to provide {@link getBasePath}.
 */
export abstract class RelativeFS {
  /** Implemented by subclasses to point to their root directory. */
  protected static getBasePath(): string {
    throw new Error('getBasePath not implemented');
  }

  /** Resolve a relative path against the base path. */
  public static fullPath(relativePath: string): string {
    return path.join(this.getBasePath(), relativePath);
  }

  public static async exists(relativePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(this.fullPath(relativePath)));
      return true;
    } catch {
      return false;
    }
  }

  public static async read(relativePath: string): Promise<string> {
    const content = await vscode.workspace.fs.readFile(
      vscode.Uri.file(this.fullPath(relativePath)),
    );
    return Buffer.from(content).toString('utf-8');
  }

  public static async write(
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const data =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(this.fullPath(relativePath)),
      data,
    );
  }

  public static async writeJson<T>(
    relativePath: string,
    value: T,
  ): Promise<void> {
    const json = JSON.stringify(value, null, 2);
    await this.write(relativePath, json);
  }

  public static async readJson<T>(relativePath: string): Promise<T> {
    const raw = await this.read(relativePath);
    return JSON.parse(raw) as T;
  }

  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.delete(
      vscode.Uri.file(this.fullPath(relativePath)),
      options,
    );
  }

  public static async createDir(relativePath: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(this.fullPath(relativePath)),
    );
  }

  public static async ensureDir(relativePath: string): Promise<void> {
    await ensureDirCommon(
      relativePath,
      this.exists.bind(this),
      this.createDir.bind(this),
    );
  }

  public static async readDir(
    relativePath: string,
  ): Promise<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(
      vscode.Uri.file(this.fullPath(relativePath)),
    );
  }

  public static async stat(relativePath: string): Promise<vscode.FileStat> {
    return vscode.workspace.fs.stat(
      vscode.Uri.file(this.fullPath(relativePath)),
    );
  }

  public static async copy(
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.copy(
      vscode.Uri.file(this.fullPath(source)),
      vscode.Uri.file(this.fullPath(destination)),
      options,
    );
  }

  public static async rename(
    oldPath: string,
    newPath: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.rename(
      vscode.Uri.file(this.fullPath(oldPath)),
      vscode.Uri.file(this.fullPath(newPath)),
      options,
    );
  }

  public static async isDir(relativePath: string): Promise<boolean> {
    try {
      return (
        await this.stat(relativePath)
      ).type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  public static async isFile(relativePath: string): Promise<boolean> {
    try {
      return (
        await this.stat(relativePath)
      ).type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  public static async isSymbolicLink(relativePath: string): Promise<boolean> {
    try {
      return (
        (await this.stat(relativePath)).type & vscode.FileType.SymbolicLink
      ) === vscode.FileType.SymbolicLink;
    } catch {
      return false;
    }
  }
}

export default RelativeFS;
