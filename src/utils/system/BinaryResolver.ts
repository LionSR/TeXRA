// Standard library imports
import * as path from 'path';

// Local imports
import { IS_WINDOWS, findToolInCommonPaths } from './platformPaths';

export interface ResolvedBinaryCommand {
  command: string;
  args: string[];
  resolvedPath?: string;
}

class BinaryResolverService {
  /**
   * Resolve a tool name to an executable path using TeXRA's platform-specific
   * search locations. Returns null when the tool is not currently discoverable.
   */
  resolvePath(toolName: string): string | null {
    return findToolInCommonPaths(toolName);
  }

  /**
   * Build an executable command for a resolved tool path. TeX Live scripts can
   * be `.pl` files, or extensionless scripts on Windows, so route them through
   * Perl when needed.
   */
  resolveCommand(toolName: string, args: string[] = []): ResolvedBinaryCommand {
    const resolvedPath = this.resolvePath(toolName);
    if (!resolvedPath) {
      return { command: toolName, args };
    }

    if (this.needsPerlLauncher(resolvedPath)) {
      return {
        command: 'perl',
        args: [resolvedPath, ...args],
        resolvedPath,
      };
    }

    return {
      command: resolvedPath,
      args,
      resolvedPath,
    };
  }

  private needsPerlLauncher(resolvedPath: string): boolean {
    return (
      resolvedPath.toLowerCase().endsWith('.pl') ||
      (IS_WINDOWS && path.extname(resolvedPath) === '')
    );
  }
}

export const BinaryResolver = new BinaryResolverService();
