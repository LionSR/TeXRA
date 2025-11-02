// Standard library imports
import * as path from 'path';

// Local imports - filesystem
import { BaseFS } from './baseFS';

/**
 * Filesystem helper for absolute paths.
 */
export class AbsoluteFS extends BaseFS {
  protected static override resolvePath(target: string): string {
    return target;
  }

  protected static override validateResolvedPath(
    resolvedPath: string,
    original: string,
  ): void {
    if (!path.isAbsolute(resolvedPath)) {
      throw new Error(`Path must be absolute: ${original}`);
    }
  }
}

export default AbsoluteFS;
