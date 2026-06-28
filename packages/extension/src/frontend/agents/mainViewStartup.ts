import { createMainViewStartupController } from '@controllers/mainView/MainViewStartupControllerFactory';
import { getAuthStatus } from '@commands/auth';
import type { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';

export function createExtensionMainViewStartupController(): MainViewStartupController {
  return createMainViewStartupController({
    getAuthStatus,
    agentCatalogRefresh: 'runtime',
  });
}
