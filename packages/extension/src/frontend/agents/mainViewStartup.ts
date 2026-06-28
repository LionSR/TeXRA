import { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';
import {
  computeRuntimeAgentOptionsData,
  refreshRuntimeAgentCatalog,
} from '@agent/runtime/agentResolution';
import { getAuthStatus } from '@commands/auth';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { getConfig } from '@utils/config';

import { loadOptions } from './optionsLoader';

export function createExtensionMainViewStartupController(): MainViewStartupController {
  return new MainViewStartupController({
    getConfig,
    getAuthStatus,
    loadOptions,
    loadModelOptions: computeModelOptionsData,
    loadAgentOptions: computeRuntimeAgentOptionsData,
    refreshAgentCatalog: refreshRuntimeAgentCatalog,
  });
}
