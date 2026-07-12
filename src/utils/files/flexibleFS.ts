// Local imports - filesystem
import type { FileLocation } from '@shared/schemas';
import { AbsoluteFS } from './absoluteFS';

/**
 * Filesystem operations for FileLocation objects.
 * All paths must be FileLocation - use pathToLocation() to convert strings.
 */
class FlexibleFSImpl {
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

    const stats = await this.stat(target);
    return stats.size > threshold;
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

  write(target: FileLocation, content: string | Uint8Array): Promise<void> {
    return AbsoluteFS.write(target.absolutePath, content);
  }

  ensureDir(target: FileLocation): Promise<void> {
    return AbsoluteFS.ensureDir(target.absolutePath);
  }

  delete(
    target: FileLocation,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    return AbsoluteFS.delete(target.absolutePath, options);
  }

  stat(target: FileLocation) {
    return AbsoluteFS.stat(target.absolutePath);
  }
}

export const FlexibleFS = new FlexibleFSImpl();
