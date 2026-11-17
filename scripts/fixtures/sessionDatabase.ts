/**
 * The production modules the desktop e2e fixtures and the packaged smoke
 * drive, bundled by `loadDatabaseFixture`
 * (`scripts/desktop-package-smoke-environment.mjs`). The fixture's type is
 * this module's, so a name listed here is a name the bundle has.
 */
export {
  databaseLayer,
  globalDatabaseLayer,
} from '@controllers/session/databaseLayer';
export { SessionWorkspace } from '@shared/session/sessionWorkspace';
export { Database, GlobalDatabase } from '@shared/session/database';
export { SessionRowSchema } from '@shared/schemas';
export {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
export { openDesktopProjectRecords } from '@desktop/main/desktopProjectRecords';
export { nodePlatformServices } from '@platform/defaults/nodeServices';
export { ToolRegistry, toolTable } from '@tools/toolTable';
export { servicePaths } from '@texra/controllers/server/discovery';
