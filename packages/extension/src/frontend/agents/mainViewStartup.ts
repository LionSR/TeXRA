import { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';
import { getAuthStatus } from '@commands/auth';
import { getConfig } from '@utils/config';

import {
  loadAgentOptions,
  loadModelOptions,
  loadOptions,
  refreshAgentCatalog,
} from './optionsLoader';

export function createExtensionMainViewStartupController(): MainViewStartupController {
  return new MainViewStartupController({
    getConfig,
    getAuthStatus,
    loadOptions,
    loadModelOptions,
    loadAgentOptions,
    refreshAgentCatalog,
  });
}
