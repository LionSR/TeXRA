import * as path from 'node:path';

import { Effect } from 'effect';
import { LRUCache } from 'lru-cache';

import { hasExtension, withLogChannel } from '@texra-ai/harness/host';
import {
  executeCommand,
  existsAtAbsolute,
  whichOnExtendedPath,
} from '@texra-ai/harness/node';
import { commandDirs } from '@texra/platform/defaults/commandDirs';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const IS_WINDOWS = process.platform === 'win32';

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

// Found paths by tool name, kept for the session (bounded). A miss is not
// kept: a tool installed mid-session is found by the next lookup.
const foundTools = new LRUCache<string, string>({ max: 64 });

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
  for (const dir of commandDirs()) {
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
    const found = whichOnExtendedPath(name, commandDirs());
    if (found) return found;
  }
  return null;
});

/**
 * Locate a tool in the TeX directories, the TeX database (TeX Live scripts
 * only), then the extended PATH. Unsafe tool names are rejected. A found
 * path is kept for the session.
 */
const findTool = Effect.fn('findTool')(function* (
  tool: string,
): Effect.fn.Return<string | null, never, ChildProcessSpawner> {
  const cached = foundTools.get(tool);
  if (cached !== undefined) return cached;
  const found = yield* findToolUncached(tool);
  if (found !== null) foundTools.set(tool, found);
  return found;
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
 * Find `name` on this machine (the TeX directories, the TeX database for
 * TeX Live scripts, then the extended PATH) and say how to launch it: a
 * Perl script runs through `perl`. Null when the tool is not there now.
 */
export const findCommand = Effect.fn('findCommand')(function* (
  name: string,
  options: {
    /** Launch this path instead of searching for the tool. */
    readonly path?: string;
  } = {},
): Effect.fn.Return<FoundCommand | null, never, ChildProcessSpawner> {
  const resolvedPath = options.path ?? (yield* findTool(name));
  if (!resolvedPath) return null;
  return needsPerlLauncher(name, resolvedPath, IS_WINDOWS)
    ? { command: 'perl', args: [resolvedPath], resolvedPath }
    : { command: resolvedPath, args: [], resolvedPath };
});
