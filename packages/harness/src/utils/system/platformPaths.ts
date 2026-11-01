// Standard library imports
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { LRUCache } from 'lru-cache';
import which from 'which';
import { Context, Effect } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { ensureError } from '@utils/errors/errorMessage';

/**
 * An existence probe that asserts an absolute path and then asks `node:fs`.
 * A relative one is refused with a thrown `Path must be absolute`: some of
 * the roots searched come straight from the environment, so a probe that
 * quietly answered "absent" would drop those directories from PATH with
 * nothing to show for it.
 */
export function existsAtAbsolute(target: string): boolean {
  if (!path.isAbsolute(target)) {
    throw new Error(`Path must be absolute: ${target}`);
  }
  return existsSync(target);
}

/** Whether the current platform is Windows (cached at module load). */
export const IS_WINDOWS = process.platform === 'win32';

/**
 * The directories an app adds to the PATH a command runs and resolves on:
 * the package-manager and tool installs a GUI-launched process may lack.
 * Absent, none.
 */
export const CommandDirs = Context.Reference<() => readonly string[]>(
  '@texra-ai/harness/CommandDirs',
  { defaultValue: () => () => [] },
);

/**
 * The user's home directory, or `undefined` where none resolves.
 * `os.homedir()` throws a SystemError (UV_ENOENT) where it cannot be
 * determined (a uid with no passwd entry and no `HOME`: containers, CI, some
 * remote setups), and can return an empty string. Every file the caller would
 * read under the home directory is then skipped, so the failure is logged at
 * warn rather than read as "no such file".
 */
export const homeDirectory: Effect.Effect<string | undefined> = Effect.try({
  try: () => os.homedir(),
  catch: ensureError,
}).pipe(
  Effect.filterOrFail(
    (home) => home !== '',
    () => new Error('os.homedir() returned an empty string'),
  ),
  Effect.catch((error) =>
    Effect.logWarning(
      `The home directory could not be resolved; files under it (user settings, skills, ignore rules, logins) are skipped: ${error.message}`,
    ).pipe(Effect.as(undefined)),
  ),
  withLogChannel('platformPaths'),
);

// Cache for extended PATH strings. Bounded so a process that mutates PATH many
// times over its lifetime can't grow this unbounded; in practice only a handful
// of distinct base paths are ever seen.
interface ExtendedPathEntry {
  /** The extended PATH as it stood when every `absent` directory was absent. */
  readonly result: string;
  /** Candidate directories that did not exist when `result` was computed. */
  readonly absent: readonly string[];
}

const cachedExtendedPaths = new LRUCache<string, ExtendedPathEntry>({
  max: 16,
});

/**
 * Extend PATH with the `appDirs` (`CommandDirs`) that are missing.
 *
 * The result is cached per input PATH, but a cached answer that *skipped* a
 * directory is only reused while that directory is still absent. A miss must
 * not be memoized for the process lifetime: the user installs git on the
 * advice of our own "Git not found in PATH" message, and on Windows the new
 * machine PATH never reaches this already-running process — so the install is
 * invisible unless this recomputes. Re-checking only the previously absent
 * candidates keeps the steady state to a handful of `stat`s.
 */
function extendEnvPath(
  basePath: string | undefined,
  appDirs: readonly string[],
): string {
  const base = basePath ?? (process.env.PATH || '');
  const cacheKey = [base, ...appDirs].join('\0');
  const cached = cachedExtendedPaths.get(cacheKey);
  if (cached && !cached.absent.some(existsAtAbsolute)) {
    return cached.result;
  }
  const segments = base.split(path.delimiter).filter(Boolean);
  const absent: string[] = [];
  for (const dir of appDirs) {
    if (segments.includes(dir)) continue;
    if (existsAtAbsolute(dir)) segments.push(dir);
    else absent.push(dir);
  }
  const result = segments.join(path.delimiter);
  cachedExtendedPaths.set(cacheKey, { result, absent });
  return result;
}

/**
 * Return a copy of `env` whose PATH is {@link extendEnvPath}'s, written under
 * the key the environment already uses.
 *
 * Windows spells the variable `Path`, and a plain object copied out of
 * `process.env` keeps that spelling: `process.env` itself is case-insensitive
 * there, but an ordinary object is not. Assigning `.PATH` on the copy
 * therefore leaves the original `Path` beside it and hands the child both
 * spellings of one variable, with no defined rule for which survives — so on
 * Windows the extension silently applied or did not, per spawn. Writing the
 * key that is already present is the whole fix.
 */
export function withExtendedPath<T extends NodeJS.ProcessEnv>(
  env: T,
  appDirs: readonly string[],
): T {
  // Every spelling present is collapsed into the first one, not just
  // overwritten: a caller that merges its own `PATH` override onto a Windows
  // `Path` arrives here already holding two, and writing one of them back
  // would leave the other beside it — the very state this exists to prevent.
  // The value taken is the last one merged, which is the override the caller
  // meant; it is written under the first spelling, which is the platform's.
  const keys = Object.keys(env).filter((name) => name.toLowerCase() === 'path');
  const key = keys[0] ?? 'PATH';
  const extended: Record<string, string | undefined> = {
    ...env,
    [key]: extendEnvPath(env[keys.at(-1) ?? key], appDirs),
  };
  for (const shadowed of keys.slice(1)) delete extended[shadowed];
  // The computed key defeats inference; every other entry is carried through
  // unchanged and the one written is a string, so the shape is T's.
  return extended as T;
}

/** `env` on the PATH extended with the app's {@link CommandDirs}. */
export const withCommandDirs = <T extends NodeJS.ProcessEnv>(
  env: T,
): Effect.Effect<T> =>
  Effect.map(CommandDirs, (appDirs) => withExtendedPath(env, appDirs()));

/**
 * Resolve `name` on the process PATH extended with `appDirs` the way a shell
 * would, or null on a miss. In-process (npm `which`), and PATHEXT-aware on
 * Windows, so a bare `npm` resolves to its `npm.cmd` shim without spawning
 * `where`/`which`.
 */
export function whichOnExtendedPath(
  name: string,
  appDirs: readonly string[],
): string | null {
  return which.sync(name, {
    nothrow: true,
    path: extendEnvPath(undefined, appDirs),
    pathExt: process.env.PATHEXT,
  });
}
