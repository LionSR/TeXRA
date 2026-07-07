/**
 * VS Code adapter for the platform-agnostic FileSystemProvider.
 *
 * Wraps vscode.workspace.fs operations, converting string paths to vscode.Uri.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

import * as nodeFsOps from '@platform/defaults/nodeFsOps';
import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { FileSystemProvider, FileStat } from '@platform/interfaces';

const CHANNEL = 'VscodeFileSystem';

export class VscodeFileSystem implements FileSystemProvider {
  /**
   * Per-path append chains. vscode.workspace.fs has no atomic append, so
   * appendFile() does read-modify-write; serializing per path stops concurrent
   * appends to the same file from racing (each reading the same bytes, the last
   * write clobbering the others).
   */
  private readonly appendChains = new Map<string, Promise<void>>();

  async stat(target: string): Promise<FileStat> {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return {
      type: stat.type,
      ctime: stat.ctime,
      mtime: stat.mtime,
      size: stat.size,
    };
  }

  // isSymlink / realPath / readFileChunk bypass vscode.workspace.fs and use
  // node:fs directly; the shared bodies and the rationale live in nodeFsOps.
  isSymlink = nodeFsOps.isSymlink;

  realPath = nodeFsOps.realPath;

  async readFile(target: string): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(vscode.Uri.file(target));
  }

  readFileChunk = nodeFsOps.readFileChunk;

  async writeFile(target: string, content: Uint8Array): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), content);
  }

  async writeFileAtomic(target: string, content: Uint8Array): Promise<void> {
    // vscode.workspace.fs has no atomic write; stage to a unique sibling temp
    // and rename over the target so an unclean exit can't leave a torn file.
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const tmpUri = vscode.Uri.file(tmp);
    try {
      await vscode.workspace.fs.writeFile(tmpUri, content);
      await vscode.workspace.fs.rename(tmpUri, vscode.Uri.file(target), {
        overwrite: true,
      });
    } catch (err) {
      try {
        await vscode.workspace.fs.delete(tmpUri);
      } catch (cleanupError) {
        logger.debug(CHANNEL, `Failed to clean up temp file: ${tmp}`, {
          data: cleanupError,
        });
      }
      throw err;
    }
  }

  async appendFile(target: string, content: Uint8Array): Promise<void> {
    const prior = this.appendChains.get(target) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(() => this.appendFileUnsafe(target, content));
    this.appendChains.set(target, next);
    try {
      await next;
    } finally {
      if (this.appendChains.get(target) === next) {
        this.appendChains.delete(target);
      }
    }
  }

  private async appendFileUnsafe(
    target: string,
    content: Uint8Array,
  ): Promise<void> {
    // vscode.workspace.fs has no native append, so read-modify-write through
    // the same virtual FS keeps appends on the one authority writeFile uses
    // (a remote/web workspace is not the local node disk). appendFile()
    // serializes these per path so the read-modify-write can't race.
    const uri = vscode.Uri.file(target);
    let existing: Uint8Array;
    try {
      existing = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
      existing = new Uint8Array(0);
    }
    const merged = new Uint8Array(existing.length + content.length);
    merged.set(existing, 0);
    merged.set(content, existing.length);
    await vscode.workspace.fs.writeFile(uri, merged);
  }

  async delete(
    target: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.delete(vscode.Uri.file(target), options);
  }

  async createDirectory(target: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(target));
  }

  async readDirectory(target: string): Promise<[string, number][]> {
    // vscode.FileType values are numerically compatible with our FileType.
    return vscode.workspace.fs.readDirectory(vscode.Uri.file(target));
  }

  async copy(
    source: string,
    dest: string,
    options?: { overwrite?: boolean; dereference?: boolean },
  ): Promise<void> {
    if (options?.dereference) {
      await fs.promises.cp(source, dest, {
        recursive: true,
        force: !!options.overwrite,
        errorOnExist: !options.overwrite,
        dereference: true,
      });
      return;
    }
    await vscode.workspace.fs.copy(
      vscode.Uri.file(source),
      vscode.Uri.file(dest),
      options,
    );
  }

  async rename(
    source: string,
    dest: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.rename(
      vscode.Uri.file(source),
      vscode.Uri.file(dest),
      options,
    );
  }
}
