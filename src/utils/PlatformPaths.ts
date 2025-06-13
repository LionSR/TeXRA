// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import glob from 'glob';

/**
 * Return common directories for external tools based on the current platform.
 */
export function getExtraDirs(): string[] {
  const dirs: string[] = [];
  const platform = process.platform;

  if (platform === 'darwin') {
    dirs.push(
      '/opt/homebrew/bin', // Homebrew on Apple Silicon
      '/usr/local/bin',
      '/Library/TeX/texbin',
      '/usr/texbin',
    );
  } else if (platform === 'win32') {
    dirs.push(
      'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
      'C:\\Program Files\\MiKTeX\\miktex\\bin',
      'C:\\Program Files (x86)\\MiKTeX\\miktex\\bin',
    );
  } else {
    // Linux and others
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/usr/texbin',
      '/home/linuxbrew/.linuxbrew/bin',
    );
  }

  const texlivePatterns =
    platform === 'win32'
      ? ['C:/texlive/*/bin/*']
      : ['/usr/local/texlive/*/bin/*'];
  for (const pattern of texlivePatterns) {
    try {
      const matches = glob.sync(pattern).sort().reverse();
      dirs.push(...matches);
    } catch {
      // ignore glob errors
    }
  }

  return Array.from(new Set(dirs));
}

/**
 * Extend the provided PATH with platform-specific directories.
 */
export function extendEnvPath(
  basePath: string = process.env.PATH || '',
): string {
  const segments = basePath.split(path.delimiter).filter(Boolean);
  for (const dir of getExtraDirs()) {
    if (!segments.includes(dir) && fs.existsSync(dir)) {
      segments.push(dir);
    }
  }
  return segments.join(path.delimiter);
}

/**
 * Locate a tool by searching the common platform directories.
 */
export function findToolInCommonPaths(tool: string): string | null {
  const candidates = [tool];
  if (process.platform === 'win32' && !tool.toLowerCase().endsWith('.exe')) {
    candidates.unshift(`${tool}.exe`);
  }

  for (const dir of getExtraDirs()) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
