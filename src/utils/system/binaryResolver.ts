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

interface ResolveCommandOptions {
  /** Build the command for this path instead of searching for the tool. */
  resolvedPath?: string;
  /** Windows launcher rules; defaults to the running platform. */
  isWindows?: boolean;
}

/**
 * TeX Live scripts can be `.pl` files, or extensionless scripts on Windows, so
 * route those through Perl.
 */
function needsPerlLauncher(
  toolName: string,
  resolvedPath: string,
  isWindows: boolean,
): boolean {
  return (
    hasExtension(resolvedPath, '.pl') ||
    (isWindows &&
      path.extname(resolvedPath) === '' &&
      WINDOWS_EXTENSIONLESS_PERL_TOOLS.has(toolName))
  );
}

/**
 * Build an executable command for a tool, resolved through TeXRA's
 * platform-specific search locations unless the caller already knows the path.
 * Returns null when the tool is not currently discoverable.
 */
export function resolveOptionalCommand(
  toolName: string,
  args: string[] = [],
  options: ResolveCommandOptions = {},
): ResolvedBinaryCommand | null {
  const resolvedPath = options.resolvedPath ?? findToolInCommonPaths(toolName);
  if (!resolvedPath) return null;
  if (
    needsPerlLauncher(toolName, resolvedPath, options.isWindows ?? IS_WINDOWS)
  ) {
    return { command: 'perl', args: [resolvedPath, ...args], resolvedPath };
  }
  return { command: resolvedPath, args, resolvedPath };
}
