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
  whichOnExtendedPath,
} from './platformPaths';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const WINDOWS_EXTENSIONLESS_PERL_TOOLS = new Set([
  'latexdiff',
  'latexdiff-vc',
  'latexindent',
  'latexmk',
]);

/**
 * The TeX Live Perl scripts that live under `texmf-dist/scripts`: the only
 * tools the TeX database can locate. Every other name (`lake`, `codex`, `gs`,
 * a binary the setup assistant asks about) never reaches `kpsewhich`.
 */
const TEXMF_SCRIPTS = new Set([
  ...WINDOWS_EXTENSIONLESS_PERL_TOOLS,
  'texcount',
]);

/** A `kpsewhich` lookup over the ls-R database answers in milliseconds. */
const KPSEWHICH_TIMEOUT_MS = 3_000;

/** A command found on this machine, and how to launch it. */
export interface FoundCommand {
  /** The program to spawn: the tool itself, or `perl` for a Perl script. */
  readonly command: string;
  /** The arguments that come before the caller's own (the script's path). */
  readonly args: readonly string[];
  /** The absolute path the lookup found. */
  readonly resolvedPath: string;
}

/** How long a miss is remembered before the tool is looked up again. */
const MISS_TTL_MS = 60_000;

// Lookups by tool name, bounded so a long-lived session that probes many
// distinct names can't grow this unbounded. A hit is kept for the session; a
// miss expires after MISS_TTL_MS, so repeated session opens do not repeat the
// search and a tool installed mid-session is still picked up.
const findToolCache = new LRUCache<string, { readonly path: string | null }>({
  max: 64,
});

/**
 * Drop every remembered miss, so the next lookup of a tool the user may have
 * just installed searches again. Found paths are kept.
 */
export function forgetToolMisses(): void {
  const misses = [...findToolCache.entries()].filter(
    ([, entry]) => entry.path === null,
  );
  for (const [tool] of misses) findToolCache.delete(tool);
}

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
  // A tool name that climbs out of the search directories is refused.
  if (path.normalize(tool).includes('..')) {
    yield* Effect.logWarning(`Unsafe tool name rejected: ${tool}`).pipe(
      withLogChannel('platformPaths'),
    );
    return null;
  }
  const candidates = toolCandidates(tool);
  for (const dir of getExtraDirs()) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (existsAtAbsolute(candidate)) return candidate;
    }
  }
  // A TeX Live script is found through the TeX database's scripts tree rather
  // than PATH, so it stays a subprocess. A plain `kpsewhich <name>` searches
  // TEXINPUTS for a `.tex` file instead: it never finds a script, and a
  // recursive `//` entry there can walk a large tree for minutes.
  const script = path.basename(tool, '.pl');
  if (TEXMF_SCRIPTS.has(script)) {
    const result = yield* executeCommand(
      ['kpsewhich', '-format=texmfscripts', `${script}.pl`],
      {
        cwd: process.cwd(),
        settings: undefined,
        timeout: KPSEWHICH_TIMEOUT_MS,
        quiet: true,
      },
    );
    if (result.exitCode === 0 && result.stdout) return result.stdout;
  }
  for (const name of candidates) {
    const found = whichOnExtendedPath(name);
    if (found) return found;
  }
  return null;
});

/**
 * Locate a tool in the common directories, the TeX database (TeX Live
 * scripts only), then PATH. Unsafe tool names are rejected. Found paths are
 * cached for the session; a miss is remembered for a minute, so a tool
 * installed mid-session is picked up after that without a reload.
 */
const findTool = Effect.fn('findTool')(function* (
  tool: string,
  fresh: boolean,
): Effect.fn.Return<string | null, never, ChildProcessSpawner> {
  const cached = findToolCache.get(tool);
  if (cached !== undefined && !(fresh && cached.path === null))
    return cached.path;
  const result = yield* findToolUncached(tool);
  findToolCache.set(
    tool,
    { path: result },
    result === null ? { ttl: MISS_TTL_MS } : undefined,
  );
  return result;
});

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
 * Find `name` on this machine (the common tool directories, the TeX
 * database for TeX Live scripts, then the extended PATH) and say how to
 * launch it: a Perl script runs through `perl`. Null when the tool is not
 * there now. A miss is remembered for a minute unless `fresh` asks again.
 */
export const findCommand = Effect.fn('findCommand')(function* (
  name: string,
  options: {
    /** Launch this path instead of searching for the tool. */
    readonly path?: string;
    /** Search again even when the tool was missed a moment ago: the caller
     *  follows an install. A found path is never searched again. */
    readonly fresh?: boolean;
  } = {},
): Effect.fn.Return<FoundCommand | null, never, ChildProcessSpawner> {
  const resolvedPath =
    options.path ?? (yield* findTool(name, options.fresh ?? false));
  if (!resolvedPath) return null;
  return needsPerlLauncher(name, resolvedPath, IS_WINDOWS)
    ? { command: 'perl', args: [resolvedPath], resolvedPath }
    : { command: resolvedPath, args: [], resolvedPath };
});
