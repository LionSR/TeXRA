// Node imports
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Local imports - test support
import { REPO_ROOT } from '@test/support/repoScan';

export { REPO_ROOT };
export const DESKTOP_SRC_DIR = repoPath('packages', 'desktop', 'src');

export function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

export function desktopSourcePath(...segments: string[]): string {
  return resolve(DESKTOP_SRC_DIR, ...segments);
}

export function moduleFileUrl(path: string): string {
  return pathToFileURL(path).href;
}
