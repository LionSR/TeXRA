// Standard library imports
import * as path from 'path';

// Local imports - filesystem
import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

function isAbsolute(target: string): boolean {
  return path.isAbsolute(target);
}

export async function existsFlexible(target: string): Promise<boolean> {
  return isAbsolute(target)
    ? AbsoluteFS.exists(target)
    : WorkspaceFS.exists(target);
}

/**
 * Check whether a file exists and contains more than a minimal amount of data.
 *
 * Files shorter than the threshold (default 15 bytes) are considered trivial
 * and treated as empty artifacts.
 */
export async function existsAndNonTrivialFlexible(
  target: string,
  threshold: number = 15,
): Promise<boolean> {
  if (!(await existsFlexible(target))) {
    return false;
  }

  const content = await readFlexible(target);
  return content.length > threshold;
}

export async function readFlexible(target: string): Promise<string> {
  return isAbsolute(target)
    ? AbsoluteFS.read(target)
    : WorkspaceFS.read(target);
}

export async function readBytesFlexible(target: string): Promise<Buffer> {
  return isAbsolute(target)
    ? AbsoluteFS.readBytes(target)
    : WorkspaceFS.readBytes(target);
}

export async function writeFlexible(
  target: string,
  content: string | Uint8Array,
): Promise<void> {
  if (isAbsolute(target)) {
    await AbsoluteFS.write(target, content);
    return;
  }

  try {
    await WorkspaceFS.write(target, content);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ELOOP') {
      throw error;
    }

    const absoluteTarget = WorkspaceFS.fullPath(target);
    await AbsoluteFS.delete(absoluteTarget, {
      recursive: true,
      useTrash: false,
    });
    await WorkspaceFS.write(target, content);
  }
}

export async function ensureDirFlexible(target: string): Promise<void> {
  if (isAbsolute(target)) {
    await AbsoluteFS.ensureDir(target);
    return;
  }

  await WorkspaceFS.ensureDir(target);
}

export async function deleteFlexible(
  target: string,
  options?: { recursive?: boolean; useTrash?: boolean },
): Promise<void> {
  if (isAbsolute(target)) {
    await AbsoluteFS.delete(target, options);
    return;
  }

  await WorkspaceFS.delete(target, options);
}

export async function statFlexible(target: string) {
  return isAbsolute(target)
    ? AbsoluteFS.stat(target)
    : WorkspaceFS.stat(target);
}

export function toAbsolutePath(target: string): string {
  return isAbsolute(target) ? target : WorkspaceFS.fullPath(target);
}

export function toRelativeFromWorkspace(target: string): string {
  if (!isAbsolute(target)) {
    return target;
  }

  const base = WorkspaceFS.getPath();
  if (!base) {
    return target;
  }

  return path.relative(base, target);
}
