/**
 * The production modules the desktop e2e fixtures and the packaged smoke
 * drive, bundled by `loadDatabaseFixture`
 * (`scripts/desktop-package-smoke-environment.mjs`). The fixture's type is
 * this module's, so a name listed here is a name the bundle has.
 */
import { Layer } from 'effect';

import { AppNamespace } from '@utils/system/appNamespace';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';

/** TeXRA's namespace, as its process layer serves it: names the store file. */
export const appNamespaceLayer = Layer.succeed(AppNamespace)(
  TEXRA_SETTINGS.catalog.namespace,
);
export { databaseLayer } from '@controllers/session/databaseLayer';
export { globalDatabaseLayer } from '@controllers/session/globalDatabaseLayer';
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
