/**
 * Platform-specific package-manager probing for the "git is missing" prompt.
 * VS Code-free so the capability check can live outside the command layer.
 */
import { execaSync } from 'execa';

import { extendEnvPath } from '@utils/system/platformPaths';

export interface GitInstallOption {
  tool: string;
  command: string;
}

/**
 * Platform-specific package-manager install options surfaced when `git` is
 * missing from PATH. Each option pairs the package-manager binary (used to
 * probe whether the PM is installed) with the full install command.
 */
export const GIT_INSTALL_OPTIONS: Partial<
  Record<NodeJS.Platform, GitInstallOption>
> = {
  darwin: { tool: 'brew', command: 'brew install git' },
  win32: { tool: 'winget', command: 'winget install --id Git.Git -e' },
  linux: { tool: 'apt-get', command: 'sudo apt-get install git' },
};

export function isToolAvailable(tool: string): boolean {
  return (
    execaSync(tool, ['--version'], {
      reject: false,
      env: { ...process.env, PATH: extendEnvPath() },
    }).exitCode === 0
  );
}
