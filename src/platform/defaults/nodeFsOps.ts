// Standard library imports
import * as fs from 'node:fs';

/**
 * The filesystem operations that always go through Node's `fs.promises`, even
 * in the VS Code host: `vscode.workspace.fs` offers no chunked read and does
 * not reliably report the symbolic-link bit across platforms. Both
 * `FileSystemProvider` implementations (Node and VS Code) delegate here, so the
 * Node-fs fallback surface — and the reason it bypasses the host FS — lives in
 * one place. The extension host is always Node, so this is safe there too.
 */

export async function isSymlink(target: string): Promise<boolean> {
  const lstats = await fs.promises.lstat(target);
  return lstats.isSymbolicLink();
}

export async function realPath(target: string): Promise<string> {
  return fs.promises.realpath(target);
}

export async function readFileChunk(
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
