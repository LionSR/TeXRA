import type * as SessionDatabase from './fixtures/sessionDatabase.ts';

export interface DesktopSmokePaths {
  profile: string;
}

export function buildDesktopSmokeEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  paths: DesktopSmokePaths,
): NodeJS.ProcessEnv;

export type DatabaseFixture = typeof SessionDatabase;

export function loadDatabaseFixture(): Promise<DatabaseFixture>;
export function rememberOpenProject(
  dataRoot: string,
  workspaceRoot: string,
): Promise<void>;
