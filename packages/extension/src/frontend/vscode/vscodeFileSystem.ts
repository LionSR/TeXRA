/**
 * VS Code adapter for the platform-agnostic FileSystemProvider.
 *
 * Wraps vscode.workspace.fs operations, converting string paths to vscode.Uri.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';

import type {
  FileSystemProvider,
  FileStat,
} from '@platform/interfaces/filesystem';

export class VscodeFileSystem implements FileSystemProvider {
  async stat(target: string): Promise<FileStat> {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return {
      type: stat.type,
      ctime: stat.ctime,
      mtime: stat.mtime,
      size: stat.size,
    };
  }

  async realPath(target: string): Promise<string> {
    return fs.promises.realpath(target);
  }

  async readFile(target: string): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(vscode.Uri.file(target));
  }

  async readFileChunk(
    target: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const handle = await fs.promises.open(target, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async writeFile(target: string, content: Uint8Array): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), content);
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
