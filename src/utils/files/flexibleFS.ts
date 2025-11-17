// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - filesystem
import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';
import type { FileLocation } from './taskRunStorage';

const CHANNEL = 'flexibleFS';
logger.initialize(CHANNEL);

/**
 * Filesystem operations for FileLocation objects and string paths.
 * Prefer using FileLocation for type safety and clarity.
 */
export class FlexibleFS {
  private toAbsolutePath(target: string | FileLocation): string {
    if (typeof target === 'string') {
      return path.isAbsolute(target) ? target : WorkspaceFS.fullPath(target);
    }
    return target.absolutePath;
  }

  exists(target: string | FileLocation): Promise<boolean> {
    return AbsoluteFS.exists(this.toAbsolutePath(target));
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
    target: string | FileLocation,
    threshold: number = 15,
  ): Promise<boolean> {
    if (!(await this.exists(target))) {
      return false;
    }

    const content = await this.read(target);
    return content.length > threshold;
  }

  read(target: string | FileLocation): Promise<string> {
    return AbsoluteFS.read(this.toAbsolutePath(target));
  }

  readBytes(target: string | FileLocation): Promise<Buffer> {
    return AbsoluteFS.readBytes(this.toAbsolutePath(target));
  }

  appendFile(
    target: string | FileLocation,
    content: string | Uint8Array,
  ): Promise<void> {
    return AbsoluteFS.appendFile(this.toAbsolutePath(target), content);
  }

  async write(
    target: string | FileLocation,
    content: string | Uint8Array,
  ): Promise<void> {
    const absolutePath = this.toAbsolutePath(target);

    try {
      await AbsoluteFS.write(absolutePath, content);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ELOOP') {
        throw error;
      }

      const replacementSize =
        typeof content === 'string'
          ? Buffer.byteLength(content, 'utf-8')
          : content.byteLength;
      logger.warn(
        CHANNEL,
        `Detected circular symlink while writing ${absolutePath}, replaced with file (${replacementSize} bytes)`,
      );
      await AbsoluteFS.delete(absolutePath, {
        recursive: true,
        useTrash: false,
      });
      await AbsoluteFS.write(absolutePath, content);
    }
  }

  async ensureDir(target: string | FileLocation): Promise<void> {
    await AbsoluteFS.ensureDir(this.toAbsolutePath(target));
  }

  async delete(
    target: string | FileLocation,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await AbsoluteFS.delete(this.toAbsolutePath(target), options);
  }

  stat(target: string | FileLocation) {
    return AbsoluteFS.stat(this.toAbsolutePath(target));
  }
}

export const flexibleFS = new FlexibleFS();
