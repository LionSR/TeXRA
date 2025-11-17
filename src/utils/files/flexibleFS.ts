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
 * Filesystem operations for FileLocation objects.
 * All paths must be FileLocation - use pathToLocation() to convert strings.
 */
export class FlexibleFS {
  exists(target: FileLocation): Promise<boolean> {
    return AbsoluteFS.exists(target.absolutePath);
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
    target: FileLocation,
    threshold: number = 15,
  ): Promise<boolean> {
    if (!(await this.exists(target))) {
      return false;
    }

    const content = await this.read(target);
    return content.length > threshold;
  }

  read(target: FileLocation): Promise<string> {
    return AbsoluteFS.read(target.absolutePath);
  }

  readBytes(target: FileLocation): Promise<Buffer> {
    return AbsoluteFS.readBytes(target.absolutePath);
  }

  appendFile(
    target: FileLocation,
    content: string | Uint8Array,
  ): Promise<void> {
    return AbsoluteFS.appendFile(target.absolutePath, content);
  }

  async write(
    target: FileLocation,
    content: string | Uint8Array,
  ): Promise<void> {
    const absolutePath = target.absolutePath;

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

  async ensureDir(target: FileLocation): Promise<void> {
    await AbsoluteFS.ensureDir(target.absolutePath);
  }

  async delete(
    target: FileLocation,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await AbsoluteFS.delete(target.absolutePath, options);
  }

  stat(target: FileLocation) {
    return AbsoluteFS.stat(target.absolutePath);
  }
}

export const flexibleFS = new FlexibleFS();
