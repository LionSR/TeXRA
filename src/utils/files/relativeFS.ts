// Standard library imports
import * as path from 'node:path';

// Local imports - filesystem
import { BaseFS } from './baseFS';

export abstract class RelativeFS extends BaseFS {
  protected static getBasePath(): string {
    throw new Error('Relative filesystem requires a base path.');
  }

  protected static override resolvePath(target: string): string {
    // If target is already absolute, return it directly.
    // path.join() incorrectly concatenates absolute paths instead of returning them.
    return path.isAbsolute(target)
      ? target
      : path.join(this.getBasePath(), target);
  }
}
