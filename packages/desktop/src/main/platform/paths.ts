import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { app } from 'electron';

import { BUNDLED_AGENT_DIRECTORY_NAMES } from '@agent/index/BundledAgentDirectories';

interface WorkspacePathOptions {
  env?: Partial<Pick<NodeJS.ProcessEnv, 'TEXRA_WORKSPACE_PATH'>>;
  argv?: readonly string[];
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
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(1);
  const argvWorkspacePath = getWorkspacePathArg(argv);
  if (argvWorkspacePath) return resolve(argvWorkspacePath);

  const configured = env.TEXRA_WORKSPACE_PATH?.trim();
  if (configured) return resolve(configured);

  return undefined;
}

function getWorkspacePathArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg == null) continue;
    if (arg === '--texra-workspace') {
      return argv[index + 1]?.trim();
    }
    if (arg.startsWith('--texra-workspace=')) {
      return arg.slice('--texra-workspace='.length).trim();
    }
  }
  return undefined;
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
