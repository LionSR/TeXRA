import { computeAgentOptionsData } from '@agent/index';
import type { MainViewStartupOptions } from '@controllers/mainView/MainViewStartupController';
import { computeModelOptionsData } from '@model/computeModelOptions';

import { loadMainViewTeamOptions } from './teamOptionsLoader';

export async function loadOptions(): Promise<MainViewStartupOptions> {
  const [modelOptions, agentOptions, teamOptions] = await Promise.all([
    computeModelOptionsData(),
    computeAgentOptionsData(),
    loadMainViewTeamOptions(),
  ]);

  return {
    agentOptions,
    modelOptions,
    teamOptions,
  };
}
