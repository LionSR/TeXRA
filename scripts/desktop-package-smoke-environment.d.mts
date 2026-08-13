export interface DesktopSmokePaths {
  profile: string;
  userData: string;
}

export function buildDesktopSmokeEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  paths: DesktopSmokePaths,
): NodeJS.ProcessEnv;
