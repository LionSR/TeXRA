// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utils
import { ensureDirCommon } from './ensureDirCommon';

const CHANNEL = 'absoluteFS';
logger.initialize(CHANNEL);

/**
 * AbsoluteFS provides a unified interface for file system operations on absolute paths.
 * All methods validate that paths are absolute before performing operations.
 */
export class AbsoluteFS {
  /**
   * Validates that a path is absolute
   */
  private static validatePath(filePath: string, methodName: string): void {
    if (!path.isAbsolute(filePath)) {
      throw new Error(
        `${methodName}: Path must be absolute, got relative path: ${filePath}`,
      );
    }
  }

  // ===== Async Methods =====

  /**
   * Check if a file or directory exists
   */
  public static async exists(filePath: string): Promise<boolean> {
    this.validatePath(filePath, 'exists');
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file as UTF-8 text
   */
  public static async read(filePath: string): Promise<string> {
    this.validatePath(filePath, 'read');
    const uri = vscode.Uri.file(filePath);
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content).toString('utf-8');
  }

  /**
   * Read a file as raw bytes
   */
  public static async readBytes(filePath: string): Promise<Buffer> {
    this.validatePath(filePath, 'readBytes');
    const uri = vscode.Uri.file(filePath);
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content);
  }

  /**
   * Write content to a file (text or binary)
   */
  public static async write(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.validatePath(filePath, 'write');
    const uri = vscode.Uri.file(filePath);
    const data =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(uri, data);
  }

  /**
   * Delete a file or directory
   */
  public static async delete(
    filePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    this.validatePath(filePath, 'delete');
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.delete(uri, options);
  }

  /**
   * Create a directory (with parents if needed)
   */
  public static async createDir(filePath: string): Promise<void> {
    this.validatePath(filePath, 'createDir');
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.createDirectory(uri);
  }

  /**
   * Ensure a directory exists, creating it if necessary
   */
  public static async ensureDir(filePath: string): Promise<void> {
    this.validatePath(filePath, 'ensureDir');
    await ensureDirCommon(
      filePath,
      this.exists.bind(this),
      this.createDir.bind(this),
    );
  }

  /**
   * Read directory contents
   */
  public static async readDir(
    dirPath: string,
  ): Promise<[string, vscode.FileType][]> {
    this.validatePath(dirPath, 'readDir');
    const uri = vscode.Uri.file(dirPath);
    return await vscode.workspace.fs.readDirectory(uri);
  }

  /**
   * Get file stats (VS Code API)
   */
  public static async stat(filePath: string): Promise<vscode.FileStat> {
    this.validatePath(filePath, 'stat');
    const uri = vscode.Uri.file(filePath);
    return await vscode.workspace.fs.stat(uri);
  }

  /**
   * Copy a file or directory
   */
  public static async copy(
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    this.validatePath(source, 'copy source');
    this.validatePath(destination, 'copy destination');
    const sourceUri = vscode.Uri.file(source);
    const destUri = vscode.Uri.file(destination);
    await vscode.workspace.fs.copy(sourceUri, destUri, options);
  }

  /**
   * Move/rename a file or directory
   */
  public static async rename(
    oldPath: string,
    newPath: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    this.validatePath(oldPath, 'rename oldPath');
    this.validatePath(newPath, 'rename newPath');
    const oldUri = vscode.Uri.file(oldPath);
    const newUri = vscode.Uri.file(newPath);
    await vscode.workspace.fs.rename(oldUri, newUri, options);
  }

  // ===== Sync Methods =====

  /**
   * Check if a file or directory exists (sync)
   */
  public static existsSync(filePath: string): boolean {
    this.validatePath(filePath, 'existsSync');
    return fs.existsSync(filePath);
  }

  /**
   * Read a file as UTF-8 text (sync)
   */
  public static readSync(filePath: string): string {
    this.validatePath(filePath, 'readSync');
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Read a file as buffer (sync)
   */
  public static readBytesSync(filePath: string): Buffer {
    this.validatePath(filePath, 'readBytesSync');
    return fs.readFileSync(filePath);
  }

  /**
   * Write content to a file (sync)
   */
  public static writeSync(filePath: string, content: string | Buffer): void {
    this.validatePath(filePath, 'writeSync');
    if (typeof content === 'string') {
      fs.writeFileSync(filePath, content, 'utf-8');
    } else {
      fs.writeFileSync(filePath, content);
    }
  }

  /**
   * Delete a file (sync)
   */
  public static deleteSync(filePath: string): void {
    this.validatePath(filePath, 'deleteSync');
    fs.unlinkSync(filePath);
  }

  /**
   * Create a directory (sync)
   */
  public static mkdirSync(
    dirPath: string,
    options?: { recursive?: boolean },
  ): void {
    this.validatePath(dirPath, 'mkdirSync');
    fs.mkdirSync(dirPath, options);
  }

  /**
   * Ensure a directory exists (sync), creating it if necessary
   */
  public static ensureDirSync(dirPath: string): void {
    this.validatePath(dirPath, 'ensureDirSync');
    if (!this.existsSync(dirPath)) {
      this.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Read directory contents (sync)
   */
  public static readDirSync(dirPath: string): string[] {
    this.validatePath(dirPath, 'readDirSync');
    return fs.readdirSync(dirPath);
  }

  /**
   * Get file stats (sync)
   */
  public static statSync(filePath: string): fs.Stats {
    this.validatePath(filePath, 'statSync');
    return fs.statSync(filePath);
  }

  // ===== Stream Methods =====

  /**
   * Create a read stream
   */
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
    this.validatePath(filePath, 'createReadStream');
    return fs.createReadStream(filePath, options);
  }

  /**
   * Create a write stream
   */
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
    this.validatePath(filePath, 'createWriteStream');
    return fs.createWriteStream(filePath, options);
  }

  // ===== Utility Methods =====

  /**
   * Delete a file with callback (for compatibility)
   */
  public static unlink(
    filePath: string,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void {
    this.validatePath(filePath, 'unlink');
    fs.unlink(filePath, callback);
  }

  /**
   * Check if path is a directory
   */
  public static async isDir(filePath: string): Promise<boolean> {
    this.validatePath(filePath, 'isDir');
    try {
      const stats = await this.stat(filePath);
      return stats.type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  /**
   * Check if path is a file
   */
  public static async isFile(filePath: string): Promise<boolean> {
    this.validatePath(filePath, 'isFile');
    try {
      const stats = await this.stat(filePath);
      return stats.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  /**
   * Check if path is a symbolic link
   */
  public static async isSymbolicLink(filePath: string): Promise<boolean> {
    this.validatePath(filePath, 'isSymbolicLink');
    try {
      const stats = await this.stat(filePath);
      return (
        (stats.type & vscode.FileType.SymbolicLink) ===
        vscode.FileType.SymbolicLink
      );
    } catch {
      return false;
    }
  }
}

export default AbsoluteFS;
