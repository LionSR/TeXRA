import {
  MainViewStartupController,
  type MainViewStartupControllerDeps,
  type MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import {
  computeRuntimeAgentOptionsData,
  refreshRuntimeAgentCatalog,
} from '@agent/runtime/agentResolution';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { getConfig as readConfig } from '@utils/config/configUtils';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewTypes';

export type MainViewAgentOptionsLoader = () => Promise<
  MainViewStartupOptions['agentOptions']
>;

export type MainViewAgentCatalogRefreshPolicy = 'none' | 'runtime';

export interface MainViewStartupControllerFactoryOptions {
  modelListRefresh?: PromiseLike<void>;
  getAuthStatus?: () => Promise<MainViewAuthStatus>;
  loadOptions?: () => Promise<MainViewStartupOptions>;
  getConfig?: MainViewStartupControllerDeps['getConfig'];
  getVisibleModels?: () => readonly string[];
  loadAgentOptions?: MainViewAgentOptionsLoader;
  agentCatalogRefresh?: MainViewAgentCatalogRefreshPolicy;
}

async function defaultGetAuthStatus(): Promise<MainViewAuthStatus> {
  return { authenticated: false };
}

/**
 * Construct the main-view startup controller with the shared option-loading
 * law used by extension and desktop hosts.
 */
export function createMainViewStartupController({
  modelListRefresh,
  getAuthStatus,
  loadOptions,
  getConfig,
  getVisibleModels,
  loadAgentOptions,
  agentCatalogRefresh = 'none',
}: MainViewStartupControllerFactoryOptions = {}): MainViewStartupController {
  return new MainViewStartupController({
    getConfig: getConfig ?? readConfig,
    loadOptions,
    loadModelOptions: async () => {
      await modelListRefresh;
      return computeModelOptionsData(getVisibleModels?.());
    },
    loadAgentOptions:
      loadAgentOptions ?? (() => computeRuntimeAgentOptionsData()),
    refreshAgentCatalog:
      agentCatalogRefresh === 'runtime'
        ? refreshRuntimeAgentCatalog
        : undefined,
    getAuthStatus: getAuthStatus ?? defaultGetAuthStatus,
  });
}
