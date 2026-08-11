import { computeAgentOptionsData } from '@agent/index';
import type { MainViewStartupOptions } from '@controllers/mainView/MainViewStartupController';
import { computeModelOptionsData } from '@model/computeModelOptions';

import { loadMainViewTeamOptions } from './teamOptionsLoader';

export type MainViewModelOptionsByCategory =
  MainViewStartupOptions['modelOptionsByCategory'];

export async function loadMainViewModelOptions(): Promise<MainViewModelOptionsByCategory> {
  // Model options no longer vary by agent category; both pickers read the
  // same list.
  const options = await computeModelOptionsData();
  return { workflow: options, toolUse: options };
}

export async function loadOptions(): Promise<MainViewStartupOptions> {
  const [modelOptionsByCategory, agentOptions, teamOptions] = await Promise.all(
    [
      loadMainViewModelOptions(),
      computeAgentOptionsData(),
      loadMainViewTeamOptions(),
    ],
  );

  return {
    agentOptions,
    modelOptionsByCategory,
    teamOptions,
  };
}
