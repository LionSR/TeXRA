export interface DesktopSmokePaths {
  profile: string;
}

export function buildDesktopSmokeEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  paths: DesktopSmokePaths,
): NodeJS.ProcessEnv;

export type DatabaseFixture = Pick<
  typeof import('@controllers/session/Database'),
  'databaseLayer' | 'globalDatabaseLayer'
> &
  Pick<typeof import('@controllers/session/WorkspaceRoots'), 'WorkspaceRoots'> &
  Pick<
    typeof import('@shared/session/database'),
    'Database' | 'GlobalDatabase'
  > &
  Pick<typeof import('@shared/session/sessionEvents'), 'ProcessIdentity'> &
  Pick<
    typeof import('@shared/schemas'),
    'qualifyAggregateId' | 'SessionRowSchema'
  > &
  Pick<
    typeof import('@platform/defaults/workspaceStorage'),
    'resolveGlobalStoragePath' | 'resolveWorkspaceStoragePath'
  > &
  Pick<
    typeof import('@desktop/main/desktopProjectRecords'),
    'openDesktopProjectRecords'
  > &
  Pick<
    typeof import('@platform/defaults/nodeProcesses'),
    'nodeProcesses' | 'processOwnerId'
  > &
  Pick<
    typeof import('@platform/defaults/nodePlatform'),
    'nodePlatformServices'
  > &
  Pick<typeof import('@tools/toolTable'), 'ToolRegistry' | 'toolTable'> &
  Pick<typeof import('@texra/controllers/server/discovery'), 'servicePaths'>;

export function loadDatabaseFixture(): Promise<DatabaseFixture>;
export function rememberOpenProject(
  dataRoot: string,
  workspacePath: string,
): Promise<void>;
