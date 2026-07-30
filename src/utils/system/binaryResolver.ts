// Standard library imports
import * as path from 'node:path';

// Local imports
import { hasExtension } from '@utils/core/pathCore';
import { IS_WINDOWS, findToolInCommonPaths } from './platformPaths';

const WINDOWS_EXTENSIONLESS_PERL_TOOLS = new Set([
  'latexdiff',
  'latexdiff-vc',
  'latexindent',
  'latexmk',
]);

export interface ResolvedBinaryCommand {
  command: string;
  args: string[];
  resolvedPath: string;
}

export interface BinaryResolverOptions {
  findTool(toolName: string): string | null;
  isWindows: boolean;
}

export interface BinaryCommandOptions {
  resolvedPath?: string;
}

export class BinaryResolverService {
  constructor(
    private readonly options: BinaryResolverOptions = {
      findTool: findToolInCommonPaths,
      isWindows: IS_WINDOWS,
    },
  ) {}

  /**
   * Resolve a tool name to an executable path using TeXRA's platform-specific
   * search locations. Returns null when the tool is not currently discoverable.
   */
  findPath(toolName: string): string | null {
    return this.options.findTool(toolName);
  }

  /**
   * Build an executable command for a resolved tool path. TeX Live scripts can
   * be `.pl` files, or extensionless scripts on Windows, so route them through
   * Perl when needed.
   */
  resolveOptionalCommand(
    toolName: string,
    args: string[] = [],
    commandOptions: BinaryCommandOptions = {},
  ): ResolvedBinaryCommand | null {
    const resolvedPath = commandOptions.resolvedPath ?? this.findPath(toolName);
    if (!resolvedPath) return null;
    if (this.needsPerlLauncher(toolName, resolvedPath)) {
      return { command: 'perl', args: [resolvedPath, ...args], resolvedPath };
    }
    return { command: resolvedPath, args, resolvedPath };
  }

  private needsPerlLauncher(toolName: string, resolvedPath: string): boolean {
    return (
      hasExtension(resolvedPath, '.pl') ||
      (this.options.isWindows &&
        path.extname(resolvedPath) === '' &&
        WINDOWS_EXTENSIONLESS_PERL_TOOLS.has(toolName))
    );
  }
}

export const BinaryResolver = new BinaryResolverService();
