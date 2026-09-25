import * as path from 'node:path';

import { Effect } from 'effect';
import { LRUCache } from 'lru-cache';

import { withLogChannel } from '@logger/effectLog';
import { hasExtension } from '@utils/core/pathCore';
import { executeCommand } from './execUtils';
import {
  IS_WINDOWS,
  existsAtAbsolute,
  getExtraDirs,
  isPathSafe,
  reportExtraDirWarnings,
  whichOnExtendedPath,
} from './platformPaths';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

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

// Resolved tool paths, bounded so a long-lived session that probes many
// distinct tool names can't grow this unbounded. Only hits are cached; misses
// are always re-checked so tools installed mid-session are picked up without
// a reload.
const findToolCache = new LRUCache<string, string>({ max: 64 });

function toolCandidates(tool: string): string[] {
  const candidates = [tool];
  if (!hasExtension(tool, '.pl')) candidates.push(`${tool}.pl`);
  if (IS_WINDOWS) {
    // Special handling for Ghostscript on Windows
    if (tool === 'gs') {
      candidates.push('gswin64c', 'gswin32c', 'gswin64c.exe', 'gswin32c.exe');
    } else if (!hasExtension(tool, '.exe')) {
      candidates.unshift(`${tool}.exe`);
    }
  }
  return candidates;
}

const findToolUncached = Effect.fnUntraced(function* (tool: string) {
  if (!isPathSafe(tool)) {
    yield* Effect.logWarning(`Unsafe tool name rejected: ${tool}`).pipe(
      withLogChannel('platformPaths'),
    );
    return null;
  }
  const candidates = toolCandidates(tool);
  const extraDirs = getExtraDirs();
  yield* reportExtraDirWarnings;
  for (const dir of extraDirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (existsAtAbsolute(candidate)) return candidate;
    }
  }
  // kpsewhich resolves files through the TeX database rather than PATH, so it
  // stays a subprocess. npm `which` only searches PATH.
  for (const name of candidates) {
    const result = yield* executeCommand(['kpsewhich', name], {
      cwd: process.cwd(),
      settings: undefined,
      quiet: true,
    });
    if (result.exitCode === 0 && result.stdout) return result.stdout;
  }
  for (const name of candidates) {
    const found = whichOnExtendedPath(name);
    if (found) return found;
  }
  return null;
});

/**
 * Locate a tool in the common directories, the TeX database, then PATH.
 * Unsafe tool names are rejected. Found paths are cached for the session;
 * misses are always re-checked so that tools installed mid-session are
 * picked up without a reload.
 */
export const findToolInCommonPaths = Effect.fn('findToolInCommonPaths')(
  function* (
    tool: string,
  ): Effect.fn.Return<string | null, never, ChildProcessSpawner> {
    const cached = findToolCache.get(tool);
    if (cached !== undefined) return cached;
    const result = yield* findToolUncached(tool);
    if (result !== null) findToolCache.set(tool, result);
    return result;
  },
);

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
export const resolveOptionalCommand = Effect.fn('resolveOptionalCommand')(
  function* (
    toolName: string,
    args: string[] = [],
    options: ResolveCommandOptions = {},
  ): Effect.fn.Return<
    ResolvedBinaryCommand | null,
    never,
    ChildProcessSpawner
  > {
    const resolvedPath =
      options.resolvedPath ?? (yield* findToolInCommonPaths(toolName));
    if (!resolvedPath) return null;
    if (
      needsPerlLauncher(toolName, resolvedPath, options.isWindows ?? IS_WINDOWS)
    ) {
      return { command: 'perl', args: [resolvedPath, ...args], resolvedPath };
    }
    return { command: resolvedPath, args, resolvedPath };
  },
);
