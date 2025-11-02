// Standard library imports
import * as fs from 'fs';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { ensureDirCommon } from './ensureDirCommon';

const toUri = (filePath: string) => vscode.Uri.file(filePath);

/**
 * Thin wrapper around VS Code's filesystem API for absolute paths.
 * The implementation intentionally stays small—callers are expected
 * to validate inputs before invoking these helpers.
 */
export class AbsoluteFS {
  // ===== Async Methods =====

  public static async exists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(toUri(filePath));
      return true;
    } catch {
      return false;
    }
  }

  public static async read(filePath: string): Promise<string> {
    const content = await vscode.workspace.fs.readFile(toUri(filePath));
    return Buffer.from(content).toString('utf-8');
  }

  public static async readBytes(filePath: string): Promise<Buffer> {
    const content = await vscode.workspace.fs.readFile(toUri(filePath));
    return Buffer.from(content);
  }

  public static async write(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const data =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(toUri(filePath), data);
  }

  public static async delete(
    filePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.delete(toUri(filePath), options);
  }

  public static async createDir(filePath: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(toUri(filePath));
  }

  public static async ensureDir(filePath: string): Promise<void> {
    await ensureDirCommon(
      filePath,
      this.exists.bind(this),
      this.createDir.bind(this),
    );
  }

  public static async readDir(
    dirPath: string,
  ): Promise<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(toUri(dirPath));
  }

  public static async stat(filePath: string): Promise<vscode.FileStat> {
    return vscode.workspace.fs.stat(toUri(filePath));
  }

  public static async copy(
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.copy(
      toUri(source),
      toUri(destination),
      options,
    );
  }

  public static async rename(
    oldPath: string,
    newPath: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.rename(toUri(oldPath), toUri(newPath), options);
  }

  public static async isDir(filePath: string): Promise<boolean> {
    try {
      return (await this.stat(filePath)).type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  public static async isFile(filePath: string): Promise<boolean> {
    try {
      return (await this.stat(filePath)).type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  public static async isSymbolicLink(filePath: string): Promise<boolean> {
    try {
      return (
        (await this.stat(filePath)).type & vscode.FileType.SymbolicLink
      ) === vscode.FileType.SymbolicLink;
    } catch {
      return false;
    }
  }

  // ===== Sync Methods =====

  public static existsSync(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  public static readSync(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  public static readBytesSync(filePath: string): Buffer {
    return fs.readFileSync(filePath);
  }

  public static writeSync(filePath: string, content: string | Buffer): void {
    if (typeof content === 'string') {
      fs.writeFileSync(filePath, content, 'utf-8');
    } else {
      fs.writeFileSync(filePath, content);
    }
  }

  public static deleteSync(filePath: string): void {
    fs.unlinkSync(filePath);
  }

  public static mkdirSync(
    dirPath: string,
    options?: { recursive?: boolean },
  ): void {
    fs.mkdirSync(dirPath, options);
  }

  public static ensureDirSync(dirPath: string): void {
    if (!this.existsSync(dirPath)) {
      this.mkdirSync(dirPath, { recursive: true });
    }
  }

  public static readDirSync(dirPath: string): string[] {
    return fs.readdirSync(dirPath);
  }

  public static statSync(filePath: string): fs.Stats {
    return fs.statSync(filePath);
  }

  // ===== Stream Methods =====

  public static createReadStream(
    filePath: string,
    options?:
      | BufferEncoding
      | (fs.ObjectEncodingOptions & {
          flags?: string;
          encoding?: BufferEncoding;
          fd?: number;
          mode?: number;
          autoClose?: boolean;
          start?: number;
          end?: number;
          highWaterMark?: number;
        }),
  ): fs.ReadStream {
    return fs.createReadStream(filePath, options);
  }

  public static createWriteStream(
    filePath: string,
    options?:
      | BufferEncoding
      | (fs.ObjectEncodingOptions & {
          flags?: string;
          encoding?: BufferEncoding;
          fd?: number;
          mode?: number;
          autoClose?: boolean;
          start?: number;
        }),
  ): fs.WriteStream {
    return fs.createWriteStream(filePath, options);
  }

  // ===== Utility Methods =====

  public static unlink(
    filePath: string,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void {
    fs.unlink(filePath, callback);
  }
}

export default AbsoluteFS;
