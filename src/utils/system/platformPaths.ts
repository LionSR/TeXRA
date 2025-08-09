// Standard library imports
import * as path from 'path';

// Third-party imports
import glob from 'glob';
import { execaSync } from 'execa';

// Local imports - log
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'platformPaths';
logger.initialize(CHANNEL);

const texTools = ['latexdiff', 'latexindent', 'latexmk'];

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
      'C:\\Program Files (x86)\\MiKTeX 2.9\\miktex\\bin',
    );
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push(
        `${localAppData.replace(/\\\\/g, '/')}/Programs/MiKTeX/miktex/bin/x64`,
      );
    }
  } else {
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/usr/texbin',
      '/home/linuxbrew/.linuxbrew/bin',
    );
  }

  const texDistPatterns =
    platform === 'win32'
      ? ['C:/texlive/*/bin/*']
      : ['/usr/local/texlive/*/bin/*'];
  const texScriptPatterns: string[] = [];
  if (platform === 'win32') {
    for (const tool of texTools) {
      texScriptPatterns.push(`C:/texlive/*/texmf-dist/scripts/${tool}`);
    }
  } else {
    for (const tool of texTools) {
      texScriptPatterns.push(`/usr/local/texlive/*/texmf-dist/scripts/${tool}`);
      texScriptPatterns.push(`/usr/share/texlive/texmf-dist/scripts/${tool}`);
    }
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const normalized = homeDir.replace(/\\/g, '/');
    texDistPatterns.push(`${normalized}/texlive/*/bin/*`);
    texDistPatterns.push(`${normalized}/TinyTeX/bin/*`);
    for (const tool of texTools) {
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
    } catch {
      // ignore glob errors
    }
  }

  for (const pattern of texScriptPatterns) {
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
  if (!tool.toLowerCase().endsWith('.pl')) {
    candidates.push(`${tool}.pl`);
  }
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
    } catch {
      // ignore kpsewhich errors
    }
  }
  return null;
}
