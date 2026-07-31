import { computeAgentOptionsData } from '@agent/index';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { AgentCategory } from '@shared/schemas/agent';

import { loadMainViewTeamOptions } from './teamOptionsLoader';

type ModelOptionsData = Awaited<ReturnType<typeof computeModelOptionsData>>;

export interface MainViewModelOptionsByCategory {
  workflow: ModelOptionsData;
  toolUse: ModelOptionsData;
}

export interface OptionsPayload {
  agentOptions: Awaited<ReturnType<typeof computeAgentOptionsData>>;
  modelOptions: ModelOptionsData;
  modelOptionsByCategory: MainViewModelOptionsByCategory;
  teamOptions: Awaited<ReturnType<typeof loadMainViewTeamOptions>>;
}

export async function loadMainViewModelOptions(
  models?: readonly string[],
): Promise<MainViewModelOptionsByCategory> {
  const [workflow, toolUse] = await Promise.all([
    computeModelOptionsData(models, undefined, {
      agentCategory: AgentCategory.Workflow,
    }),
    computeModelOptionsData(models, undefined, {
      agentCategory: AgentCategory.ToolUse,
    }),
  ]);

  return { workflow, toolUse };
}

export async function loadOptions(): Promise<OptionsPayload> {
  const [modelOptionsByCategory, agentOptions, teamOptions] = await Promise.all(
    [
      loadMainViewModelOptions(),
      computeAgentOptionsData(),
      loadMainViewTeamOptions(),
    ],
  );

  return {
    agentOptions,
    modelOptions: modelOptionsByCategory.workflow,
    modelOptionsByCategory,
    teamOptions,
  };
}
