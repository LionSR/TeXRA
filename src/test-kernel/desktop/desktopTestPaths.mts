// Node imports
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

export const REPO_ROOT = resolve(DESKTOP_TEST_DIR, '../../..');
export const DESKTOP_SRC_DIR = repoPath('packages', 'desktop', 'src');

export function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

export function desktopSourcePath(...segments: string[]): string {
  return repoPath('packages', 'desktop', 'src', ...segments);
}

export function moduleFileUrl(path: string): string {
  return pathToFileURL(path).href;
}
