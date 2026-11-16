// Node imports
import { resolve } from 'node:path';

// Local imports - test support
import { REPO_ROOT } from '@test/support/repoRoot';

const DESKTOP_SRC_DIR = repoPath('packages', 'desktop', 'src');

export function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

export function desktopSourcePath(...segments: string[]): string {
  return resolve(DESKTOP_SRC_DIR, ...segments);
}
