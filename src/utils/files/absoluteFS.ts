// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import { BaseFS, type PathInput } from './baseFS';

/**
 * Filesystem helper for absolute paths.
 */
export class AbsoluteFS extends BaseFS {
  protected static override resolvePath(target: PathInput): PathInput {
    return target;
  }

  protected static override validateResolvedPath(
    resolvedPath: PathInput,
    original: PathInput,
  ): void {
    const candidate =
      resolvedPath instanceof vscode.Uri ? resolvedPath.fsPath : resolvedPath;
    if (!path.isAbsolute(candidate)) {
      throw new Error(`Path must be absolute: ${candidate}`);
    }
  }
}

export default AbsoluteFS;
