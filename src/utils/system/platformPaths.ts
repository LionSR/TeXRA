// Standard library imports
import * as path from 'path';

// Third-party imports
import glob from 'glob';
import { execaSync } from 'execa';

// Local imports - log
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

// Common LaTeX tool names used across the system
const TEX_TOOLS = ['latexdiff', 'latexindent', 'latexmk'] as const;

const CHANNEL = 'platformPaths';
logger.initialize(CHANNEL);

// Cache for extra directories to avoid repeated glob operations
let cachedExtraDirs: string[] | null = null;

const DEFAULT_MSYS_ROOTS = ['C:\\msys64', 'C:\\msys32'];
const MSYS_SUBDIRS = ['usr\\bin', 'mingw64\\bin', 'mingw32\\bin'];

/**
 * Return common tool directories based on the current platform.
 * Results are cached for the session to improve performance.
 */
export function getExtraDirs(): string[] {
  // Return cached value if available
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
  } else if (platform === 'win32') {
    dirs.push(
      'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
      'C:\\Program Files\\MiKTeX\\miktex\\bin',
      'C:\\Program Files (x86)\\MiKTeX\\miktex\\bin',
      'C:\\Program Files (x86)\\MiKTeX 2.9\\miktex\\bin',
      'C:\\Program Files\\gs\\gs9.56.1\\bin',
      'C:\\Program Files\\gs\\gs9.55.0\\bin',
      'C:\\Program Files\\gs\\gs9.54.0\\bin',
      'C:\\Program Files (x86)\\gs\\gs9.56.1\\bin',
      'C:\\Program Files (x86)\\gs\\gs9.55.0\\bin',
      'C:\\Program Files (x86)\\gs\\gs9.54.0\\bin',
    );
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push(
        path.join(localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
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
      try {
        const matches = glob
          .sync(path.join(scoopDir, 'apps', '*', 'current'))
          .sort()
          .reverse();
        dirs.push(...matches);
      } catch (_err) {
        // ignore glob errors
      }
    }

    const msysRoots = new Set<string>(DEFAULT_MSYS_ROOTS);
    if (process.env.MSYS2_HOME) {
      msysRoots.add(process.env.MSYS2_HOME);
    }

    for (const root of msysRoots) {
      for (const sub of MSYS_SUBDIRS) {
        const dir = path.join(root, sub);
        if (
          AbsoluteFS.existsSync(path.join(dir, 'perl.exe')) &&
          !dirs.includes(dir)
        ) {
          dirs.push(dir);
        }
      }
    }
  } else {
    // Linux/Unix paths
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/snap/bin', // Ubuntu snap packages
      '/home/linuxbrew/.linuxbrew/bin',
    );
  }

  const texDistPatterns =
    platform === 'win32'
      ? ['C:/texlive/*/bin/*']
      : ['/usr/local/texlive/*/bin/*'];
  const texScriptPatterns: string[] = [];
  if (platform === 'win32') {
    for (const tool of TEX_TOOLS) {
      texScriptPatterns.push(`C:/texlive/*/texmf-dist/scripts/${tool}`);
    }
  } else {
    for (const tool of TEX_TOOLS) {
      texScriptPatterns.push(`/usr/local/texlive/*/texmf-dist/scripts/${tool}`);
      texScriptPatterns.push(`/usr/share/texlive/texmf-dist/scripts/${tool}`);
      // Additional Debian/Ubuntu paths
      texScriptPatterns.push(`/usr/share/texmf/scripts/${tool}`);
      texScriptPatterns.push(`/usr/share/texmf-dist/scripts/${tool}`);
    }
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const normalized = homeDir.replace(/\\/g, '/');
    texDistPatterns.push(`${normalized}/texlive/*/bin/*`);
    texDistPatterns.push(`${normalized}/TinyTeX/bin/*`);
    for (const tool of TEX_TOOLS) {
      texScriptPatterns.push(
        `${normalized}/texlive/*/texmf-dist/scripts/${tool}`,
      );
      texScriptPatterns.push(
        `${normalized}/TinyTeX/texmf-dist/scripts/${tool}`,
      );
    }
  }

  for (const pattern of texDistPatterns) {
    try {
      const matches = glob.sync(pattern).sort().reverse();
      dirs.push(...matches);
    } catch (_err) {
      // ignore glob errors
    }
  }

  for (const pattern of texScriptPatterns) {
    try {
      const matches = glob.sync(pattern).sort().reverse();
      dirs.push(...matches);
    } catch (_err) {
      // ignore glob errors
    }
  }

  // Cache and return the unique directories
  cachedExtraDirs = Array.from(new Set(dirs));
  return cachedExtraDirs;
}

// Cache for extended PATH strings
const cachedExtendedPaths = new Map<string, string>();

/**
 * Extend PATH with common directories if they are missing.
 * Results are cached based on the input PATH to improve performance.
 */
export function extendEnvPath(
  basePath: string = process.env.PATH || '',
): string {
  // Check cache first
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

  // Cache the result
  cachedExtendedPaths.set(basePath, result);

  return result;
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

/**
 * Locate a tool in the common directories.
 * Performs basic security validation on tool names.
 */
export function findToolInCommonPaths(tool: string): string | null {
  // Basic security validation
  if (!isPathSafe(tool)) {
    logger.warn(CHANNEL, `Unsafe tool name rejected: ${tool}`);
    return null;
  }
  const candidates = [tool];
  if (!tool.toLowerCase().endsWith('.pl')) {
    candidates.push(`${tool}.pl`);
  }
  if (process.platform === 'win32') {
    // Special handling for Ghostscript on Windows
    if (tool === 'gs') {
      candidates.push('gswin64c', 'gswin32c');
      candidates.push('gswin64c.exe', 'gswin32c.exe');
    } else if (!tool.toLowerCase().endsWith('.exe')) {
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

  const execOptions = {
    env: { ...process.env, PATH: extendEnvPath() },
    reject: false,
  };
  for (const name of candidates) {
    try {
      const result = execaSync('kpsewhich', [name], execOptions);
      const found = result.stdout.trim();
      if (result.exitCode === 0 && found) {
        return found;
      }
    } catch (_err) {
      // ignore kpsewhich errors
    }
  }
  // Use platform-specific command to locate tools: 'where' on Windows, 'which' on Unix
  const locateCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const name of candidates) {
    try {
      const result = execaSync(locateCmd, [name], execOptions);
      const found = result.stdout.split(/\r?\n/)[0]?.trim();
      if (result.exitCode === 0 && found) {
        return found;
      }
    } catch (_err) {
      // ignore locate command errors
    }
  }
  return null;
}
