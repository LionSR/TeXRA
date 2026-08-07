// Standard library imports
import * as fs from 'node:fs';
import * as path from 'node:path';

// Common imports
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { normalizeLineEndings } from '@utils/text/stringUtils';
import { isFile } from './fsEntryType';

/** Convert content to Buffer for writing. */
function toBuffer(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
}

/**
 * Shared filesystem helpers backed by a platform-agnostic FileSystemProvider.
 *
 * By default uses Node.js fs/promises. In VS Code, the provider is replaced
 * with one backed by vscode.workspace.fs at activation via initPlatform().
 *
 * Subclasses customize how incoming paths are resolved and validated by
 * overriding {@link resolvePath} and {@link validateResolvedPath}.
 */
export abstract class BaseFS {
  /** Resolve caller supplied path to an absolute filesystem path. */
  protected static resolvePath(target: string): string {
    return target;
  }

  /** Allow subclasses to enforce additional invariants on resolved paths. */
  protected static validateResolvedPath(
    _resolvedPath: string,
    _original: string,
  ): void {
    // Default implementation performs no validation.
  }

  protected static preparePath(this: typeof BaseFS, target: string): string {
    const resolved = this.resolvePath(target);
    this.validateResolvedPath(resolved, target);
    return resolved;
  }

  private static async statIfExists(
    this: typeof BaseFS,
    target: string,
  ): Promise<FileStat | undefined> {
    try {
      return await this.stat(target);
    } catch (error) {
      if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  // ===== Async Methods =====

  public static async exists(
    this: typeof BaseFS,
    target: string,
  ): Promise<boolean> {
    return (await this.statIfExists(target)) !== undefined;
  }

  public static async read(
    this: typeof BaseFS,
    target: string,
  ): Promise<string> {
    const content = await platform().fs.readFile(this.preparePath(target));
    return normalizeLineEndings(Buffer.from(content).toString('utf-8'));
  }

  public static async readBytes(
    this: typeof BaseFS,
    target: string,
  ): Promise<Buffer> {
    const content = await platform().fs.readFile(this.preparePath(target));
    return Buffer.from(content);
  }

  public static async write(
    this: typeof BaseFS,
    target: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await platform().fs.writeFile(this.preparePath(target), toBuffer(content));
  }

  /**
   * Crash-safe variant of {@link write} — stages to a temp file and atomically
   * renames over the target. Use for durable storage state (run/flow KV files)
   * so an unclean exit can't leave a truncated file that fails to parse on
   * resume. Not for workspace files (atomic rename would replace user symlinks).
   */
  public static async writeAtomic(
    this: typeof BaseFS,
    target: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await platform().fs.writeFileAtomic(
      this.preparePath(target),
      toBuffer(content),
    );
  }

  public static async appendFile(
    this: typeof BaseFS,
    target: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await platform().fs.appendFile(this.preparePath(target), toBuffer(content));
  }

  public static async delete(
    this: typeof BaseFS,
    target: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await platform().fs.delete(this.preparePath(target), options);
  }

  public static async createDir(
    this: typeof BaseFS,
    target: string,
  ): Promise<void> {
    await platform().fs.createDirectory(this.preparePath(target));
  }

  public static async ensureDir(
    this: typeof BaseFS,
    target: string,
  ): Promise<void> {
    try {
      await this.createDir(target);
    } catch (err) {
      // Directory already exists — silently succeed.
      // Check for both EEXIST (Node.js default) and FileExists (VS Code adapter).
      const code = (err as { code?: string }).code;
      if (code === 'EEXIST' || code === 'FileExists') {
        return;
      }
      throw err;
    }
  }

  public static async readDir(
    this: typeof BaseFS,
    target: string,
  ): Promise<[string, number][]> {
    return platform().fs.readDirectory(this.preparePath(target));
  }

  public static async stat(
    this: typeof BaseFS,
    target: string,
  ): Promise<FileStat> {
    return platform().fs.stat(this.preparePath(target));
  }

  public static async copy(
    this: typeof BaseFS,
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await platform().fs.copy(
      this.preparePath(source),
      this.preparePath(destination),
      options,
    );
  }

  public static async rename(
    this: typeof BaseFS,
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await platform().fs.rename(
      this.preparePath(source),
      this.preparePath(destination),
      options,
    );
  }

  public static async isFile(
    this: typeof BaseFS,
    target: string,
  ): Promise<boolean> {
    const stats = await this.statIfExists(target);
    return stats !== undefined && isFile(stats.type);
  }

  public static async isSymbolicLink(
    this: typeof BaseFS,
    target: string,
  ): Promise<boolean> {
    const stats = await this.statIfExists(target);
    return (
      stats !== undefined &&
      (stats.type & FileType.SymbolicLink) === FileType.SymbolicLink
    );
  }

  // ===== Sync Methods =====

  public static existsSync(this: typeof BaseFS, target: string): boolean {
    return fs.existsSync(this.preparePath(target));
  }

  public static readSync(this: typeof BaseFS, target: string): string {
    return normalizeLineEndings(
      fs.readFileSync(this.preparePath(target), 'utf-8'),
    );
  }

  public static readBytesSync(this: typeof BaseFS, target: string): Buffer {
    return fs.readFileSync(this.preparePath(target));
  }

  public static deleteSync(this: typeof BaseFS, target: string): void {
    fs.unlinkSync(this.preparePath(target));
  }

  public static mkdirSync(
    this: typeof BaseFS,
    target: string,
    options?: { recursive?: boolean },
  ): void {
    fs.mkdirSync(this.preparePath(target), options);
  }

  public static statSync(this: typeof BaseFS, target: string): fs.Stats {
    return fs.statSync(this.preparePath(target));
  }

  // ===== Stream Methods =====

  public static createReadStream(
    this: typeof BaseFS,
    target: string,
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
    target: string,
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

  // ===== Utility helpers =====

  public static fullPath(this: typeof BaseFS, target: string): string {
    return this.preparePath(target);
  }
}
