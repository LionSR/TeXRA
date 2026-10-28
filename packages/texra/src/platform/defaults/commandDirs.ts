/**
 * The directories every TeXRA host adds to the PATH its commands run and
 * resolve on (the harness's `CommandDirs`): the package managers, Git, Perl,
 * Ghostscript and TeX distributions a GUI-launched process may lack on PATH.
 */
import * as path from 'node:path';

import { globSync } from 'glob';

import { writeLogLine } from '@texra-ai/harness/host';
import { existsAtAbsolute } from '@texra-ai/harness/node';
import { normalizeFilePath, toErrorMessage } from '@texra-ai/harness/schemas';

// Common LaTeX tool names used across the system
const TEX_TOOLS = ['latexdiff', 'latexindent', 'latexmk'] as const;

// Cache for extra directories to avoid repeated glob operations
let cachedExtraDirs: string[] | null = null;

/**
 * Name a directory {@link commandDirs} had to skip. The directories are
 * computed once, synchronously, by whichever PATH consumer runs first (often
 * extension activation), with no fiber to log from, so this writes the sink
 * directly at computation time.
 */
function warnSkippedDir(message: string): void {
  writeLogLine('platformPaths', message);
}

const DEFAULT_MSYS_ROOTS = ['C:\\msys64', 'C:\\msys32'];
const MSYS_SUBDIRS = ['usr\\bin', 'mingw64\\bin', 'mingw32\\bin'];

/**
 * An absolute root read from the environment, or null.
 *
 * `existsAtAbsolute` throws on a relative path on purpose, so that a
 * mistyped root is never silently dropped. But these roots come from user
 * environment variables, and this runs inside `commandDirs()` — on the path
 * of *every* subprocess the harness spawns. A throw there is not a loud
 * failure for one directory, it is every command in the session failing with
 * `Path must be absolute`, which reads to the user as the tool being missing.
 * So a relative value is skipped and reported, never thrown.
 */
function absoluteEnvRoot(value: string, variable: string): string | null {
  if (path.isAbsolute(value)) return value;
  warnSkippedDir(
    `Ignoring ${variable}=${value}: it must be an absolute path to be searched for tools.`,
  );
  return null;
}

/** Glob matches sorted in descending order. A failed glob drops a whole tool
 *  directory from PATH, so it is named rather than silently empty. */
function globDescending(pattern: string): string[] {
  try {
    return globSync(pattern).sort().reverse();
  } catch (err) {
    warnSkippedDir(`Glob failed for ${pattern}: ${toErrorMessage(err)}`);
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
 * Return common tool directories based on the current platform.
 * Results are cached for the session to improve performance.
 * Served as `CommandDirs`, and searched first by `findCommand`.
 */
export function commandDirs(): readonly string[] {
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
    if (scoopDir && existsAtAbsolute(scoopDir)) {
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
        if (existsAtAbsolute(path.join(dir, 'perl.exe'))) {
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
        if (existsAtAbsolute(path.join(dir, 'perl.exe'))) {
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

  cachedExtraDirs = [...new Set(dirs)];
  return cachedExtraDirs;
}
