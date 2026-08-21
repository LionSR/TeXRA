import { statSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { BUNDLED_AGENT_DIRECTORY_NAMES } from '@agent/index';
import {
  getWorkspacePathInput,
  type WorkspacePathOptions,
} from '@desktop/shared/workspacePath.js';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';

interface DataRootOptions {
  env?: Partial<Pick<NodeJS.ProcessEnv, 'TEXRA_DESKTOP_E2E_USER_DATA_PATH'>>;
}

interface ResourcesPathOptions {
  appPath?: string;
  isDirectory?: (path: string) => boolean;
  resourcesPath?: string;
}

export function resolveWorkspacePath(
  options: WorkspacePathOptions = {},
): string | undefined {
  const workspacePath = getWorkspacePathInput(options);
  return workspacePath == null
    ? undefined
    : canonicalizeWorkspacePath(workspacePath);
}

/**
 * Root directory for desktop-persisted memory/history/executions data.
 *
 * Production desktop shares the CLI's `~/.texra` root ({@link
 * DEFAULT_NODE_STORAGE_ROOT}) so a workspace worked on from both hosts shows
 * one memory/history view (#7987). The e2e/dev harness isolates Electron's
 * own `userData` profile via `TEXRA_DESKTOP_E2E_USER_DATA_PATH` (see
 * `packages/desktop/src/main/index.ts`) so relaunches share one throwaway
 * profile without ever touching a developer's real `~/.texra`; when that var
 * is set, the data root stays colocated with that same isolated profile
 * (`userDataPath` is already the isolated path by the time this runs).
 */
export function resolveDesktopDataRoot(
  userDataPath: string,
  options: DataRootOptions = {},
): string {
  const env = options.env ?? process.env;
  if (env.TEXRA_DESKTOP_E2E_USER_DATA_PATH?.trim()) return userDataPath;
  return DEFAULT_NODE_STORAGE_ROOT;
}

export function resolveResourcesPath(
  mainDirname: string,
  options: ResourcesPathOptions = {},
): string {
  const appPath = options.appPath ?? app.getAppPath();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const candidates = [
    join(appPath, 'resources'),
    resourcesPath ? join(resourcesPath, 'resources') : undefined,
    join(mainDirname, '../../../extension/resources'),
    join(mainDirname, '../../../../resources'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const isDirectory = options.isDirectory ?? isExistingDirectory;
  const found = candidates.find((candidate) =>
    hasRequiredResourceDirectories(candidate, isDirectory),
  );
  if (!found) {
    throw new Error(
      `Unable to locate TeXRA resources. Checked: ${candidates.join(', ')}`,
    );
  }
  return found;
}

function hasRequiredResourceDirectories(
  candidate: string,
  isDirectory: (path: string) => boolean,
): boolean {
  return (
    isDirectory(candidate) &&
    BUNDLED_AGENT_DIRECTORY_NAMES.every((directoryName) =>
      isDirectory(join(candidate, directoryName)),
    )
  );
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
