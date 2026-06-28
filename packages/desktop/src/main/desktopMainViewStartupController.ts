import {
  type MainViewStartupControllerDeps,
  MainViewStartupController,
  type MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import { computeRuntimeAgentOptionsData } from '@agent/runtime/agentResolution';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { getConfig as readConfig } from '@utils/config/configUtils';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewTypes';

export type DesktopMainViewAgentOptionsLoader = () => Promise<
  MainViewStartupOptions['agentOptions']
>;

export interface DesktopMainViewStartupControllerOptions {
  modelListRefresh?: PromiseLike<void>;
  getAuthStatus?: () => Promise<MainViewAuthStatus>;
  loadOptions?: () => Promise<MainViewStartupOptions>;
  getConfig?: MainViewStartupControllerDeps['getConfig'];
  getVisibleModels?: () => readonly string[];
  loadAgentOptions?: DesktopMainViewAgentOptionsLoader;
}

async function defaultGetAuthStatus(): Promise<MainViewAuthStatus> {
  return { authenticated: false };
}

export function createDesktopMainViewStartupController({
  modelListRefresh,
  getAuthStatus,
  loadOptions,
  getConfig,
  getVisibleModels,
  loadAgentOptions,
}: DesktopMainViewStartupControllerOptions): MainViewStartupController {
  return new MainViewStartupController({
    getConfig: getConfig ?? readConfig,
    loadOptions,
    loadModelOptions: async () => {
      await modelListRefresh;
      return computeModelOptionsData(getVisibleModels?.());
    },
    loadAgentOptions:
      loadAgentOptions ?? (() => computeRuntimeAgentOptionsData()),
    getAuthStatus: getAuthStatus ?? defaultGetAuthStatus,
  });
}
