export interface DesktopSmokePaths {
  profile: string;
  userData: string;
}

export function buildDesktopSmokeEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  paths: DesktopSmokePaths,
): NodeJS.ProcessEnv;

export type DatabaseFixture = Pick<
  typeof import('@controllers/session/Database'),
  'databaseLayer'
> &
  Pick<typeof import('@controllers/session/WorkspaceRoots'), 'WorkspaceRoots'> &
  Pick<typeof import('@shared/session/database'), 'Database'> &
  Pick<typeof import('@shared/session/sessionEvents'), 'ProcessIdentity'> &
  Pick<typeof import('@shared/schemas'), 'aggregateId'> &
  Pick<
    typeof import('@platform/defaults/workspaceStorage'),
    'resolveWorkspaceStoragePath'
  > &
  Pick<
    typeof import('@desktop/main/desktopProjectRecords'),
    'openDesktopProjectRecords'
  > &
  Pick<
    typeof import('@platform/defaults/nodeProcesses'),
    'nodeProcesses' | 'processOwnerId'
  >;

export function loadDatabaseFixture(
  userDataPath: string,
): Promise<DatabaseFixture>;
export function rememberOpenProject(
  userDataPath: string,
  workspacePath: string,
): Promise<void>;
