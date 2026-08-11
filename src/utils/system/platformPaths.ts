// Standard library imports
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { globSync } from 'glob';
import { execaSync } from 'execa';
import { LRUCache } from 'lru-cache';
import which from 'which';

// Local imports - log
import * as logger from '@logger/logUtils';
import { normalizeFilePath, unique } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { hasExtension } from '@utils/core/pathCore';

/** Whether the current platform is Windows (cached at module load). */
export const IS_WINDOWS = process.platform === 'win32';

// Common LaTeX tool names used across the system
const TEX_TOOLS = ['latexdiff', 'latexindent', 'latexmk'] as const;

const CHANNEL = 'platformPaths';

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
    const macHome = process.env.HOME;
    if (macHome) {
      dirs.push(path.join(macHome, 'bin'));
      // Claude Code's native installer — the one its docs recommend — installs
      // here, and a GUI-launched app does not inherit the shell profile that
      // would normally put it on PATH.
      dirs.push(path.join(macHome, '.local', 'bin'));
    }
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
    const localAppData =
      process.env.LOCALAPPDATA ||
      (process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, 'AppData', 'Local')
        : null);
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
      );
    }

    const scoopDir =
      process.env.SCOOP ||
      process.env.SCOOP_HOME ||
      (process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, 'scoop')
        : null);
    if (scoopDir && AbsoluteFS.existsSync(scoopDir)) {
      dirs.push(path.join(scoopDir, 'shims'));
      dirs.push(...globDescending(path.join(scoopDir, 'apps', '*', 'current')));
    }

    const msysRoots = new Set<string>(DEFAULT_MSYS_ROOTS);
    if (process.env.MSYS2_HOME) {
      msysRoots.add(process.env.MSYS2_HOME);
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
    // MiKTeX on Linux: per-user symlink directory for private installs
    const linuxHome = process.env.HOME;
    if (linuxHome) {
      dirs.push(path.join(linuxHome, 'bin'));
      // Claude Code's native installer — the one its docs recommend — installs
      // here, and a GUI-launched app does not inherit the shell profile that
      // would normally put it on PATH.
      dirs.push(path.join(linuxHome, '.local', 'bin'));
    }
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
const cachedExtendedPaths = new LRUCache<string, string>({ max: 16 });

/**
 * Extend PATH with common directories if they are missing.
 * Results are cached based on the input PATH to improve performance.
 */
export function extendEnvPath(
  basePath: string = process.env.PATH || '',
): string {
  const cached = cachedExtendedPaths.get(basePath);
  if (cached !== undefined) {
    return cached;
  }
  const segments = basePath.split(path.delimiter).filter(Boolean);
  for (const dir of getExtraDirs()) {
    if (!segments.includes(dir) && AbsoluteFS.existsSync(dir)) {
      segments.push(dir);
    }
  }
  const result = segments.join(path.delimiter);
  cachedExtendedPaths.set(basePath, result);
  return result;
}

/**
 * Environment keys that let git invoke arbitrary helper programs (editors,
 * pagers, askpass, external-diff, config overrides). Stripped before handing
 * the environment to a non-interactive git subprocess so an inherited value
 * can't run a helper or redirect config during automated operations.
 */
const GIT_UNSAFE_ENV_KEYS = new Set([
  'editor',
  'git_askpass',
  'git_config_global',
  'git_config_system',
  'git_config_count',
  'git_config',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_sequence_editor',
  'git_template_dir',
  'pager',
  'prefix',
  'ssh_askpass',
]);

/**
 * Build an environment for a non-interactive git subprocess: the current
 * environment with the helper-invoking keys in {@link GIT_UNSAFE_ENV_KEYS}
 * removed and `PATH` extended via {@link extendEnvPath} so GUI-launched hosts
 * (whose minimal PATH may omit Homebrew / /usr/local/bin) can still resolve
 * the `git` binary.
 */
export function makeMachineGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (GIT_UNSAFE_ENV_KEYS.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  env.PATH = extendEnvPath(env.PATH);
  return env;
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
    logger.warn(CHANNEL, `Unsafe tool name rejected: ${tool}`);
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
        env: { ...process.env, PATH: pathEnv },
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
