// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - filesystem
import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

const CHANNEL = 'flexibleFS';
logger.initialize(CHANNEL);

function isAbsolute(target: string): boolean {
  return path.isAbsolute(target);
}

export class FlexibleFS {
  exists(target: string): Promise<boolean> {
    return isAbsolute(target)
      ? AbsoluteFS.exists(target)
      : WorkspaceFS.exists(target);
  }

  /**
   * Check whether a file exists and contains more than a minimal amount of data.
   *
   * Files shorter than the threshold (default 15 bytes) are considered trivial
   * and treated as empty artifacts. The value loosely matches the size of empty
   * LaTeX scaffolds produced by latexindent so we can quickly skip placeholder
   * outputs without scanning their contents.
   */
  async existsAndNonTrivial(
    target: string,
    threshold: number = 15,
  ): Promise<boolean> {
    if (!(await this.exists(target))) {
      return false;
    }

    const content = await this.read(target);
    return content.length > threshold;
  }

  read(target: string): Promise<string> {
    return isAbsolute(target)
      ? AbsoluteFS.read(target)
      : WorkspaceFS.read(target);
  }

  readBytes(target: string): Promise<Buffer> {
    return isAbsolute(target)
      ? AbsoluteFS.readBytes(target)
      : WorkspaceFS.readBytes(target);
  }

  async write(target: string, content: string | Uint8Array): Promise<void> {
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
      const replacementSize =
        typeof content === 'string'
          ? Buffer.byteLength(content, 'utf-8')
          : content.byteLength;
      logger.warn(
        CHANNEL,
        `Detected circular symlink while writing ${absoluteTarget}, replaced with file (${replacementSize} bytes)`,
      );
      await AbsoluteFS.delete(absoluteTarget, {
        recursive: true,
        useTrash: false,
      });
      await WorkspaceFS.write(target, content);
    }
  }

  async appendFile(target: string, content: string): Promise<void> {
    const existing = (await this.exists(target)) ? await this.read(target) : '';
    await this.write(target, `${existing}${content}`);
  }

  async ensureDir(target: string): Promise<void> {
    if (isAbsolute(target)) {
      await AbsoluteFS.ensureDir(target);
      return;
    }

    await WorkspaceFS.ensureDir(target);
  }

  async delete(
    target: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    if (isAbsolute(target)) {
      await AbsoluteFS.delete(target, options);
      return;
    }

    await WorkspaceFS.delete(target, options);
  }

  stat(target: string) {
    return isAbsolute(target)
      ? AbsoluteFS.stat(target)
      : WorkspaceFS.stat(target);
  }

  toAbsolutePath(target: string): string {
    return isAbsolute(target) ? target : WorkspaceFS.fullPath(target);
  }

  toWorkspaceRelative(target: string): string {
    if (!isAbsolute(target)) {
      return target;
    }

    const base = WorkspaceFS.getPath();
    if (!base) {
      return target;
    }

    return path.relative(base, target);
  }
}

export const flexibleFS = new FlexibleFS();
