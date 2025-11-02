// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { ensureDirCommon } from './ensureDirCommon';

type PathInput = string;

/**
 * Shared filesystem helpers backed by VS Code's workspace API.
 *
 * Subclasses customize how incoming paths are resolved and validated by
 * overriding {@link resolvePath} and {@link validateResolvedPath}.
 */
export abstract class BaseFS {
  /** Resolve caller supplied path to an absolute filesystem path. */
  protected static resolvePath(target: PathInput): string {
    return target;
  }

  /** Allow subclasses to enforce additional invariants on resolved paths. */
  protected static validateResolvedPath(_resolvedPath: string, _original: string): void {
    // Default implementation performs no validation.
  }

  private static preparePath(this: typeof BaseFS, target: PathInput): string {
    const resolved = this.resolvePath(target);
    this.validateResolvedPath(resolved, target);
    return resolved;
  }

  protected static toUri(this: typeof BaseFS, target: PathInput): vscode.Uri {
    return vscode.Uri.file(this.preparePath(target));
  }

  // ===== Async Methods =====

  public static async exists(this: typeof BaseFS, target: PathInput): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.toUri(target));
      return true;
    } catch {
      return false;
    }
  }

  public static async read(this: typeof BaseFS, target: PathInput): Promise<string> {
    const content = await vscode.workspace.fs.readFile(this.toUri(target));
    return Buffer.from(content).toString('utf-8');
  }

  public static async readBytes(this: typeof BaseFS, target: PathInput): Promise<Buffer> {
    const content = await vscode.workspace.fs.readFile(this.toUri(target));
    return Buffer.from(content);
  }

  public static async write(
    this: typeof BaseFS,
    target: PathInput,
    content: string | Uint8Array,
  ): Promise<void> {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(this.toUri(target), data);
  }

  public static async delete(
    this: typeof BaseFS,
    target: PathInput,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.delete(this.toUri(target), options);
  }

  public static async createDir(this: typeof BaseFS, target: PathInput): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.toUri(target));
  }

  public static async ensureDir(this: typeof BaseFS, target: PathInput): Promise<void> {
    await ensureDirCommon(target, this.exists.bind(this), this.createDir.bind(this));
  }

  public static async readDir(
    this: typeof BaseFS,
    target: PathInput,
  ): Promise<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(this.toUri(target));
  }

  public static async stat(this: typeof BaseFS, target: PathInput): Promise<vscode.FileStat> {
    return vscode.workspace.fs.stat(this.toUri(target));
  }

  public static async copy(
    this: typeof BaseFS,
    source: PathInput,
    destination: PathInput,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.copy(this.toUri(source), this.toUri(destination), options);
  }

  public static async rename(
    this: typeof BaseFS,
    source: PathInput,
    destination: PathInput,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.rename(this.toUri(source), this.toUri(destination), options);
  }

  public static async isDir(this: typeof BaseFS, target: PathInput): Promise<boolean> {
    try {
      const stats = await this.stat(target);
      return stats.type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  public static async isFile(this: typeof BaseFS, target: PathInput): Promise<boolean> {
    try {
      const stats = await this.stat(target);
      return stats.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  public static async isSymbolicLink(
    this: typeof BaseFS,
    target: PathInput,
  ): Promise<boolean> {
    try {
      const stats = await this.stat(target);
      return (stats.type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;
    } catch {
      return false;
    }
  }

  // ===== Sync Methods =====

  public static existsSync(this: typeof BaseFS, target: PathInput): boolean {
    return fs.existsSync(this.preparePath(target));
  }

  public static readSync(this: typeof BaseFS, target: PathInput): string {
    return fs.readFileSync(this.preparePath(target), 'utf-8');
  }

  public static readBytesSync(this: typeof BaseFS, target: PathInput): Buffer {
    return fs.readFileSync(this.preparePath(target));
  }

  public static writeSync(
    this: typeof BaseFS,
    target: PathInput,
    content: string | Buffer,
  ): void {
    if (typeof content === 'string') {
      fs.writeFileSync(this.preparePath(target), content, 'utf-8');
      return;
    }
    fs.writeFileSync(this.preparePath(target), content);
  }

  public static deleteSync(this: typeof BaseFS, target: PathInput): void {
    fs.unlinkSync(this.preparePath(target));
  }

  public static mkdirSync(
    this: typeof BaseFS,
    target: PathInput,
    options?: { recursive?: boolean },
  ): void {
    fs.mkdirSync(this.preparePath(target), options);
  }

  public static ensureDirSync(this: typeof BaseFS, target: PathInput): void {
    if (!this.existsSync(target)) {
      this.mkdirSync(target, { recursive: true });
    }
  }

  public static readDirSync(this: typeof BaseFS, target: PathInput): string[] {
    return fs.readdirSync(this.preparePath(target));
  }

  public static statSync(this: typeof BaseFS, target: PathInput): fs.Stats {
    return fs.statSync(this.preparePath(target));
  }

  // ===== Stream Methods =====

  public static createReadStream(
    this: typeof BaseFS,
    target: PathInput,
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
    return fs.createReadStream(this.preparePath(target), options);
  }

  public static createWriteStream(
    this: typeof BaseFS,
    target: PathInput,
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
    return fs.createWriteStream(this.preparePath(target), options);
  }

  public static unlink(
    this: typeof BaseFS,
    target: PathInput,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void {
    fs.unlink(this.preparePath(target), callback);
  }

  // ===== Utility helpers =====

  public static fullPath(this: typeof BaseFS, target: PathInput): string {
    return this.preparePath(target);
  }
}

export function joinPath(base: string, relative: string): string {
  return path.join(base, relative);
}
