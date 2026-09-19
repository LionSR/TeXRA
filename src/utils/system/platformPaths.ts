// Standard library imports
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { globSync } from 'glob';
import { execaSync } from 'execa';
import { LRUCache } from 'lru-cache';
import which from 'which';

// Local imports - log
import { createLog } from '@logger/logUtils';
import { normalizeFilePath, unique } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { hasExtension } from '@utils/core/pathCore';

/** Whether the current platform is Windows (cached at module load). */
export const IS_WINDOWS = process.platform === 'win32';

// Common LaTeX tool names used across the system
const TEX_TOOLS = ['latexdiff', 'latexindent', 'latexmk'] as const;

const log = createLog('platformPaths');

// Cache for extra directories to avoid repeated glob operations
let cachedExtraDirs: string[] | null = null;

const DEFAULT_MSYS_ROOTS = ['C:\\msys64', 'C:\\msys32'];
const MSYS_SUBDIRS = ['usr\\bin', 'mingw64\\bin', 'mingw32\\bin'];

/**
 * Safe wrapper around `os.homedir()` that returns `null` instead of throwing.
 * `os.homedir()` can throw a SystemError (UV_ENOENT) in environments where the
 * home directory cannot be determined (containers, CI/CD, some remote setups).
 */
export function safeHomedir(): string | null {
  try {
    return os.homedir() || null;
  } catch {
    return null;
  }
}

/** Glob matches sorted in descending order, ignoring glob errors. */
function globDescending(pattern: string): string[] {
  try {
    return globSync(pattern).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * `~/bin` plus Claude Code's native-installer `~/.local/bin` — the one its docs
 * recommend. A GUI-launched app does not inherit the shell profile that would
 * normally put these on PATH.
 */
function pushHomeBinDirs(dirs: string[]): void {
  const home = process.env.HOME;
  if (home) {
    dirs.push(path.join(home, 'bin'), path.join(home, '.local', 'bin'));
  }
}

/**
 * An absolute root read from the environment, or null.
 *
 * `AbsoluteFS.existsSync` throws on a relative path on purpose, so a mistyped
 * root is never silently dropped. But these roots come from user environment
 * variables and this runs inside `getExtraDirs()`, on the path of *every*
 * subprocess TeXRA spawns. A throw there is not a loud failure for one
 * directory — it is every command in the session failing with
 * `Path must be absolute`, which reads to the user as the tool being missing.
 * So a relative value is skipped and reported, never thrown.
 */
function absoluteEnvRoot(value: string, variable: string): string | null {
  if (path.isAbsolute(value)) return value;
  log.warn(
    `Ignoring ${variable}=${value}: it must be an absolute path to be searched for tools.`,
  );
  return null;
}

/**
 * Return common tool directories based on the current platform.
 * Results are cached for the session to improve performance.
 * Internal helper used by extendEnvPath and findToolInCommonPaths.
 */
function getExtraDirs(): string[] {
  if (cachedExtraDirs !== null) {
    return cachedExtraDirs;
  }
  const dirs: string[] = [];
  const platform = process.platform;

  if (platform === 'darwin') {
    dirs.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Library/TeX/texbin',
      '/usr/texbin',
    );
    // MiKTeX on macOS: app bundle and default symlink targets
    dirs.push('/Applications/MiKTeX Console.app/Contents/bin');
    pushHomeBinDirs(dirs);
  } else if (platform === 'win32') {
    dirs.push(
      'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
      'C:\\Program Files\\MiKTeX\\miktex\\bin',
      'C:\\Program Files\\MiKTeX 2.9\\miktex\\bin\\x64',
      'C:\\Program Files\\MiKTeX 2.9\\miktex\\bin',
      'C:\\Program Files (x86)\\MiKTeX\\miktex\\bin',
      'C:\\Program Files (x86)\\MiKTeX 2.9\\miktex\\bin',
      // Strawberry Perl (recommended Perl distribution for Windows)
      'C:\\Strawberry\\perl\\bin',
      // Git for Windows. Its installer offers "Use Git from Git Bash only",
      // which installs git and deliberately leaves it off the system PATH —
      // indistinguishable from "git is not installed" to anything that only
      // consults PATH. Only `cmd`: it holds the wrappers meant for callers
      // outside bash, so it alone resolves `git`, while `bin` would also put
      // Git's MSYS `bash`/`sh` on every spawned command's PATH.
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\cmd',
    );

    // Ghostscript installs under a version-stamped directory. This was six
    // hardcoded 9.54-9.56 paths, so a current 10.x install was invisible unless
    // it was already on PATH. Descending sort keeps the previous preference
    // order among 9.x releases (9.56 before 9.55 before 9.54) and treats 10.x as
    // a fallback, since "gs9" sorts above "gs1" -- any installed version works,
    // so the ordering is a preference, not a correctness requirement.
    for (const programFiles of ['C:/Program Files', 'C:/Program Files (x86)']) {
      dirs.push(...globDescending(`${programFiles}/gs/*/bin`));
    }
    const localAppDataFallback = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'AppData', 'Local')
      : null;
    const localAppData = process.env.LOCALAPPDATA
      ? absoluteEnvRoot(process.env.LOCALAPPDATA, 'LOCALAPPDATA')
      : localAppDataFallback;
    if (localAppData) {
      dirs.push(
        // Modern MiKTeX per-user install
        path.join(localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
        path.join(localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin'),
        // Legacy MiKTeX 2.9 per-user install
        path.join(
          localAppData,
          'Programs',
          'MiKTeX 2.9',
          'miktex',
          'bin',
          'x64',
        ),
        path.join(localAppData, 'Programs', 'MiKTeX 2.9', 'miktex', 'bin'),
        // MiKTeX installed directly under LOCALAPPDATA (without Programs)
        path.join(localAppData, 'MiKTeX', 'miktex', 'bin', 'x64'),
        path.join(localAppData, 'MiKTeX', 'miktex', 'bin'),
        // Git for Windows installed per-user (the default when the installer
        // runs without admin rights).
        path.join(localAppData, 'Programs', 'Git', 'cmd'),
      );
    }

    const scoopEnv = process.env.SCOOP || process.env.SCOOP_HOME;
    const scoopFallback = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'scoop')
      : null;
    const scoopDir = scoopEnv
      ? absoluteEnvRoot(scoopEnv, 'SCOOP')
      : scoopFallback;
    if (scoopDir && AbsoluteFS.existsSync(scoopDir)) {
      dirs.push(path.join(scoopDir, 'shims'));
      // Forward slashes: `glob` reads a backslash as an escape unless
      // `windowsPathsNoEscape` is set, so a path.join'd pattern matches
      // nothing here. Every other Windows pattern in this file does the same.
      dirs.push(
        ...globDescending(`${normalizeFilePath(scoopDir)}/apps/*/current`),
      );
    }

    const msysRoots = new Set<string>(DEFAULT_MSYS_ROOTS);
    const msysHome = process.env.MSYS2_HOME
      ? absoluteEnvRoot(process.env.MSYS2_HOME, 'MSYS2_HOME')
      : null;
    if (msysHome) {
      msysRoots.add(msysHome);
    }

    for (const root of msysRoots) {
      for (const sub of MSYS_SUBDIRS) {
        const dir = path.join(root, sub);
        if (AbsoluteFS.existsSync(path.join(dir, 'perl.exe'))) {
          dirs.push(dir);
        }
      }
    }

    // TeX Live for Windows bundles its own Perl (tlperl) instead of putting one
    // on PATH. latexindent/latexdiff still work there because they resolve to
    // the .exe wrappers under texlive/*/bin/*, which use tlperl internally --
    // but a bare `perl` does not exist, so checkCoreDependencies() reported
    // Perl missing and told TeX Live users to install Strawberry Perl they do
    // not need. Probed after the entries above so a user-installed Perl still
    // wins; tlperl is the fallback, and it carries the modules latexindent
    // needs.
    const tlperlPatterns = ['C:/texlive/*/tlpkg/tlperl/bin'];
    if (process.env.USERPROFILE) {
      tlperlPatterns.push(
        `${normalizeFilePath(process.env.USERPROFILE)}/texlive/*/tlpkg/tlperl/bin`,
      );
    }
    for (const pattern of tlperlPatterns) {
      for (const dir of globDescending(pattern)) {
        if (AbsoluteFS.existsSync(path.join(dir, 'perl.exe'))) {
          dirs.push(dir);
        }
      }
    }
  } else {
    // Linux/Unix paths
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/opt/miktex/bin', // MiKTeX installed via APT/AUR
      '/snap/bin', // Ubuntu snap packages
      '/home/linuxbrew/.linuxbrew/bin',
    );
    pushHomeBinDirs(dirs);
  }

  const texBinPatterns =
    platform === 'win32'
      ? ['C:/texlive/*/bin/*']
      : ['/usr/local/texlive/*/bin/*'];
  const texScriptRoots =
    platform === 'win32'
      ? ['C:/texlive/*/texmf-dist/scripts']
      : [
          '/usr/local/texlive/*/texmf-dist/scripts',
          '/usr/share/texlive/texmf-dist/scripts',
          // Additional Debian/Ubuntu paths
          '/usr/share/texmf/scripts',
          '/usr/share/texmf-dist/scripts',
        ];

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const normalized = normalizeFilePath(homeDir);
    texBinPatterns.push(
      `${normalized}/texlive/*/bin/*`,
      `${normalized}/TinyTeX/bin/*`,
    );
    texScriptRoots.push(
      `${normalized}/texlive/*/texmf-dist/scripts`,
      `${normalized}/TinyTeX/texmf-dist/scripts`,
    );
  }

  // Collect matches from all TeX-related patterns
  const texPatterns = [
    ...texBinPatterns,
    ...TEX_TOOLS.flatMap((tool) =>
      texScriptRoots.map((root) => `${root}/${tool}`),
    ),
  ];
  for (const pattern of texPatterns) {
    dirs.push(...globDescending(pattern));
  }

  cachedExtraDirs = unique(dirs);
  return cachedExtraDirs;
}

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
 * Extend PATH with common directories if they are missing.
 *
 * The result is cached per input PATH, but a cached answer that *skipped* a
 * directory is only reused while that directory is still absent. A miss must
 * not be memoized for the process lifetime: the user installs git on the
 * advice of our own "Git not found in PATH" message, and on Windows the new
 * machine PATH never reaches this already-running process — so the install is
 * invisible unless this recomputes. Re-checking only the previously absent
 * candidates keeps the steady state to a handful of `stat`s.
 */
export function extendEnvPath(
  basePath: string = process.env.PATH || '',
): string {
  const cached = cachedExtendedPaths.get(basePath);
  if (cached && !cached.absent.some((dir) => AbsoluteFS.existsSync(dir))) {
    return cached.result;
  }
  const segments = basePath.split(path.delimiter).filter(Boolean);
  const absent: string[] = [];
  for (const dir of getExtraDirs()) {
    if (segments.includes(dir)) continue;
    if (AbsoluteFS.existsSync(dir)) segments.push(dir);
    else absent.push(dir);
  }
  const result = segments.join(path.delimiter);
  cachedExtendedPaths.set(basePath, { result, absent });
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
export function withExtendedPath<T extends NodeJS.ProcessEnv>(env: T): T {
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
    [key]: extendEnvPath(env[keys.at(-1) ?? key]),
  };
  for (const shadowed of keys.slice(1)) delete extended[shadowed];
  // The computed key defeats inference; every other entry is carried through
  // unchanged and the one written is a string, so the shape is T's.
  return extended as T;
}

/**
 * Check if a path is safe (doesn't contain dangerous sequences)
 */
function isPathSafe(filepath: string): boolean {
  // Normalize the path to resolve any .. sequences
  const normalized = path.normalize(filepath);
  // Check if the path tries to escape to parent directories
  return !normalized.includes('..');
}

// Resolved tool paths, bounded so a long-lived session that probes many
// distinct tool names can't grow this unbounded. Only hits are cached; misses
// are always re-checked (see below) so tools installed mid-session are picked
// up without a reload.
const findToolCache = new LRUCache<string, string>({ max: 64 });

/**
 * Locate a tool in the common directories.
 * Performs basic security validation on tool names.
 * Found paths are cached for the session; misses are always re-checked
 * so that tools installed mid-session are picked up without a reload.
 */
export function findToolInCommonPaths(tool: string): string | null {
  const cached = findToolCache.get(tool);
  if (cached !== undefined) return cached;

  const result = findToolInCommonPathsUncached(tool);
  if (result !== null) findToolCache.set(tool, result);
  return result;
}

function findToolInCommonPathsUncached(tool: string): string | null {
  // Basic security validation
  if (!isPathSafe(tool)) {
    log.warn(`Unsafe tool name rejected: ${tool}`);
    return null;
  }
  const candidates = [tool];
  if (!hasExtension(tool, '.pl')) {
    candidates.push(`${tool}.pl`);
  }
  if (IS_WINDOWS) {
    // Special handling for Ghostscript on Windows
    if (tool === 'gs') {
      candidates.push('gswin64c', 'gswin32c', 'gswin64c.exe', 'gswin32c.exe');
    } else if (!hasExtension(tool, '.exe')) {
      candidates.unshift(`${tool}.exe`);
    }
  }

  for (const dir of getExtraDirs()) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (AbsoluteFS.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const pathEnv = extendEnvPath();

  // kpsewhich resolves files through the TeX database rather than PATH, so it
  // stays a subprocess. npm `which` only searches PATH.
  for (const name of candidates) {
    try {
      const result = execaSync('kpsewhich', [name], {
        env: withExtendedPath(process.env),
        reject: false,
      });
      const found = result.stdout.trim();
      if (result.exitCode === 0 && found) {
        return found;
      }
    } catch (_err) {
      // ignore command errors
    }
  }

  // PATH lookup via npm `which` (in-process; honors PATHEXT on Windows, so no
  // `where`/`which` subprocess is needed). `nothrow` returns null on a miss.
  for (const name of candidates) {
    try {
      const found = which.sync(name, { nothrow: true, path: pathEnv });
      if (found) {
        return found;
      }
    } catch (_err) {
      // ignore resolution errors
    }
  }

  return null;
}
