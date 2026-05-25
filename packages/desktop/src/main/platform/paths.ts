import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { app } from 'electron';

import { BUNDLED_AGENT_DIRECTORY_NAMES } from '@agent/index/BundledAgentDirectories';
import { getWorkspacePathInput } from '@desktop/workspacePath.js';
export { hasWorkspacePath } from '@desktop/workspacePath.js';

interface WorkspacePathOptions {
  env?: Partial<Pick<NodeJS.ProcessEnv, 'TEXRA_WORKSPACE_PATH'>>;
  argv?: readonly string[];
  storedWorkspacePath?: string;
}

interface ResourcesPathOptions {
  appPath?: string;
  env?: Pick<NodeJS.ProcessEnv, 'TEXRA_RESOURCES_PATH'>;
  isDirectory?: (path: string) => boolean;
  resourcesPath?: string;
}

export function resolveWorkspacePath(
  options: WorkspacePathOptions = {},
): string | undefined {
  const workspacePath = getWorkspacePathInput(options);
  return workspacePath == null ? undefined : resolve(workspacePath);
}

export function resolveResourcesPath(
  mainDirname: string,
  options: ResourcesPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const configured = env.TEXRA_RESOURCES_PATH?.trim();
  const appPath = options.appPath ?? app.getAppPath();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const candidates = [
    configured,
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
