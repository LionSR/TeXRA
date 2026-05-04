import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { app } from 'electron';

import { BUNDLED_AGENT_DIRECTORY_NAMES } from '@agent/index/AgentDirectorySync';

interface WorkspacePathOptions {
  env?: Pick<NodeJS.ProcessEnv, 'TEXRA_WORKSPACE_PATH'>;
}

interface ResourcesPathOptions {
  appPath?: string;
  env?: Pick<NodeJS.ProcessEnv, 'TEXRA_RESOURCES_PATH'>;
  exists?: (path: string) => boolean;
  resourcesPath?: string;
}

export function resolveWorkspacePath(
  options: WorkspacePathOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const configured = env.TEXRA_WORKSPACE_PATH?.trim();
  return configured ? resolve(configured) : undefined;
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

  const exists = options.exists ?? existsSync;
  const found = candidates.find((candidate) =>
    hasRequiredResourceDirectories(candidate, exists),
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
  exists: (path: string) => boolean,
): boolean {
  return (
    exists(candidate) &&
    BUNDLED_AGENT_DIRECTORY_NAMES.every((directoryName) =>
      exists(join(candidate, directoryName)),
    )
  );
}
