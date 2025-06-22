// Standard library imports
import * as path from 'path';

// Third-party imports
import glob from 'glob';

// Local imports - log
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'platformPaths';
logger.initialize(CHANNEL);

/**
 * Return common tool directories based on the current platform.
 */
export function getExtraDirs(): string[] {
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
    );
  } else {
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
 * Extend PATH with common directories if they are missing.
 */
export function extendEnvPath(
  basePath: string = process.env.PATH || '',
): string {
  const segments = basePath.split(path.delimiter).filter(Boolean);
  for (const dir of getExtraDirs()) {
    if (!segments.includes(dir) && AbsoluteFS.existsSync(dir)) {
      segments.push(dir);
    }
  }
  return segments.join(path.delimiter);
}

/**
 * Locate a tool in the common directories.
 */
export function findToolInCommonPaths(tool: string): string | null {
  const candidates = [tool];
  if (process.platform === 'win32' && !tool.toLowerCase().endsWith('.exe')) {
    candidates.unshift(`${tool}.exe`);
  }

  for (const dir of getExtraDirs()) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (AbsoluteFS.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
